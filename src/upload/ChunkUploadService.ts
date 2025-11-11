import axios, { type AxiosInstance } from 'axios';
import CryptoJS from 'crypto-js';

export interface MovieMetadata {
    title: string;
    description: string;
}

export interface ChunkUploadOptions {
    onChunkUploaded?: (chunkNumber: number, progress: number) => void;
    onChunkRetry?: (chunkNumber: number, error: Error) => void;
    onProgress?: (progress: number) => void;
}

export interface UploadStatus {
    uploadId: string;
    totalChunks: number;
    uploadedChunks: number;
    progressPercentage: number;
    missingChunks: number[];
}

export class ChunkUploadService {
    private api: AxiosInstance;
    private uploadId: string | null = null;
    private fileSize: number = 0;
    private totalChunks: number = 0;
    private uploadedChunks: Set<number> = new Set();
    private options: ChunkUploadOptions;
    
    // Configuration
    private readonly CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
    private readonly MAX_CONCURRENT_CHUNKS = 3;
    private readonly CHUNK_RETRIES = 3;
    private readonly RETRY_DELAY = 1000; // 1 second
    private readonly BASE_URL = 'http://localhost:8080';

    constructor(options: ChunkUploadOptions = {}) {
        this.options = options;
        this.api = axios.create({
            baseURL: this.BASE_URL,
            timeout: 30000,
            headers: {
                'User-Agent': 'Movie-Service-Client/1.0.0'
            }
        });
    }

    async initiate(file: File, metadata: MovieMetadata): Promise<string> {
        this.fileSize = file.size;
        this.totalChunks = Math.ceil(this.fileSize / this.CHUNK_SIZE);
        this.uploadedChunks.clear();

        const mimeType = file.type || this.detectMimeType(file.name);
        this.validateFileType(file.name, mimeType);

        const requestPayload = {
            filename: file.name,
            mimeType,
            totalSize: this.fileSize,
            chunkSize: this.CHUNK_SIZE,
            movieTitle: metadata.title,
            movieDescription: metadata.description
        };

        console.log(`Starting chunk upload session for ${file.name}`);
        console.log(`File size: ${this.formatFileSize(this.fileSize)}`);
        console.log(`Chunk size: ${this.formatFileSize(this.CHUNK_SIZE)}`);
        console.log(`Total chunks: ${this.totalChunks}`);

        const response = await this.api.post('/api/movies/chunk-upload/initiate', requestPayload);
        this.uploadId = response.data.data.uploadId;

        console.log(`Upload session: ${this.uploadId}`);
        return this.uploadId!;
    }

    async uploadAllChunks(file: File): Promise<void> {
        if (!this.uploadId) {
            throw new Error('Upload not initiated. Call initiate() first.');
        }

        const chunks = Array.from({ length: this.totalChunks }, (_, index) => index);
        const concurrency = this.MAX_CONCURRENT_CHUNKS;

        for (let cursor = 0; cursor < chunks.length; cursor += concurrency) {
            const batch = chunks.slice(cursor, cursor + concurrency);
            const tasks = batch.map((chunkNumber) =>
                this.withRetry(
                    () => this.uploadChunk(file, chunkNumber),
                    this.CHUNK_RETRIES,
                    this.RETRY_DELAY
                ).catch((error) => {
                    if (this.options.onChunkRetry) {
                        this.options.onChunkRetry(chunkNumber, error);
                    }
                    throw error;
                })
            );
            await Promise.all(tasks);
        }

        console.log(`Uploaded ${this.totalChunks} chunks successfully`);
    }

    async checkStatus(): Promise<UploadStatus> {
        if (!this.uploadId) {
            throw new Error('Upload not initiated.');
        }
        const response = await this.api.get(`/api/movies/chunk-upload/${this.uploadId}/status`);
        return response.data.data;
    }

    async complete(): Promise<{ movieId: string; status: string }> {
        if (!this.uploadId) {
            throw new Error('Upload not initiated.');
        }
        const response = await this.api.post(`/api/movies/chunk-upload/${this.uploadId}/complete`);
        return response.data.data;
    }

    async cancel(): Promise<void> {
        if (!this.uploadId) {
            return;
        }
        await this.api.delete(`/api/movies/chunk-upload/${this.uploadId}`);
        this.uploadId = null;
    }

    private async uploadChunk(file: File, chunkNumber: number): Promise<void> {
        if (!this.uploadId) {
            throw new Error('Upload not initiated.');
        }

        const start = chunkNumber * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, this.fileSize);
        const chunkBlob = file.slice(start, end);
        const chunkSize = end - start;

        // Calculate checksum
        const arrayBuffer = await chunkBlob.arrayBuffer();
        const wordArray = CryptoJS.lib.WordArray.create(arrayBuffer as any);
        const checksum = CryptoJS.MD5(wordArray).toString();

        const formData = new FormData();
        formData.append('chunk', chunkBlob, `chunk_${chunkNumber}`);
        formData.append('data', JSON.stringify({
            uploadId: this.uploadId,
            chunkNumber,
            chunkSize,
            checksum
        }));

        await this.api.post(
            `/api/movies/chunk-upload/${this.uploadId}/chunks/${chunkNumber}`,
            formData,
            {
                headers: {
                    'Content-Type': 'multipart/form-data'
                }
            }
        );

        this.uploadedChunks.add(chunkNumber);
        const progress = Math.round((this.uploadedChunks.size / this.totalChunks) * 100);
        
        if (this.options.onChunkUploaded) {
            this.options.onChunkUploaded(chunkNumber, progress);
        }
        if (this.options.onProgress) {
            this.options.onProgress(progress);
        }
    }

    private async withRetry<T>(
        fn: () => Promise<T>,
        retries: number = this.CHUNK_RETRIES,
        delayMs: number = this.RETRY_DELAY
    ): Promise<T> {
        let lastError: Error | null = null;

        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error as Error;

                if (i < retries) {
                    console.warn(`Attempt ${i + 1} failed, retrying in ${delayMs}ms...`);
                    await this.delay(delayMs);
                    delayMs *= 2; // Exponential backoff
                }
            }
        }

        throw lastError;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private detectMimeType(filename: string): string {
        const extension = filename.toLowerCase().split('.').pop();
        const mimeMap: Record<string, string> = {
            'mp4': 'video/mp4',
            'webm': 'video/webm',
            'mov': 'video/quicktime',
            'avi': 'video/x-msvideo',
            'mkv': 'video/x-matroska'
        };
        return mimeMap[extension || ''] || 'video/mp4';
    }

    private validateFileType(_filename: string, mimeType: string): void {
        const supportedTypes = [
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'video/x-msvideo',
            'video/x-matroska'
        ];

        if (!supportedTypes.includes(mimeType)) {
            throw new Error(`Unsupported file type: ${mimeType}. Supported types: ${supportedTypes.join(', ')}`);
        }
    }

    private formatFileSize(bytes: number): string {
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 Bytes';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
    }

    getTotalChunks(): number {
        return this.totalChunks;
    }

    getUploadedChunksCount(): number {
        return this.uploadedChunks.size;
    }

    getUploadId(): string | null {
        return this.uploadId;
    }
}
