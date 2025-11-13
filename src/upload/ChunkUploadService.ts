import axios, { type AxiosInstance } from 'axios';
import CryptoJS from 'crypto-js';

export interface MovieMetadata {
    movieId: string;
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

export interface MovieStatus {
    movieId: string;
    status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
    qualities?: Record<string, string>;
}

export interface MovieInfo {
    movieId: string;
    title: string;
    description: string;
    status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
    qualities?: Record<string, string>;
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
            movieId: metadata.movieId
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

    async checkMovieStatus(movieId: string): Promise<MovieStatus> {
        const response = await this.api.get(`/api/movies/${movieId}/status`);
        return response.data.data;
    }

    async getMovieInfo(movieId: string): Promise<MovieInfo> {
        const response = await this.api.get(`/api/movies/${movieId}`);
        return response.data.data;
    }

    async monitorMovieStatus(
        movieId: string,
        options: {
            maxAttempts?: number;
            intervalSeconds?: number;
            onStatusChange?: (status: string, attempt: number) => void;
        } = {}
    ): Promise<MovieInfo | null> {
        const maxAttempts = options.maxAttempts || 30;
        const intervalSeconds = options.intervalSeconds || 10;

        console.log(`Starting movie status monitoring for ${movieId}`);
        console.log(`Will check every ${intervalSeconds} seconds for up to ${maxAttempts} attempts`);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const statusData = await this.checkMovieStatus(movieId);
                const status = statusData.status;

                console.log(`[${attempt}/${maxAttempts}] Current status: ${status}`);
                
                if (options.onStatusChange) {
                    options.onStatusChange(status, attempt);
                }

                if (status === 'READY') {
                    console.log('🎉 Movie is ready!');
                    const movieInfo = await this.getMovieInfo(movieId);
                    
                    if (movieInfo.qualities) {
                        console.log('Available qualities:', Object.keys(movieInfo.qualities));
                    }
                    
                    return movieInfo;
                } else if (status === 'FAILED') {
                    console.error('❌ Movie processing failed');
                    throw new Error('Movie processing failed');
                }

                if (attempt < maxAttempts) {
                    console.log(`Waiting ${intervalSeconds} seconds before next check...`);
                    await this.delay(intervalSeconds * 1000);
                }

            } catch (error) {
                console.error(`Status check attempt ${attempt} failed:`, error);

                if (attempt < maxAttempts) {
                    console.log('Retrying in 5 seconds...');
                    await this.delay(5000);
                } else {
                    throw error;
                }
            }
        }

        console.warn('⏰ Monitoring timeout reached');
        console.log('Movie may still be processing. Check manually later.');
        return null;
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
        
        // Append binary chunk data
        formData.append('chunk', chunkBlob, `chunk_${chunkNumber}`);
        
        // Append metadata as JSON with explicit content type
        const metadata = {
            uploadId: this.uploadId,
            chunkNumber,
            chunkSize,
            checksum
        };
        const metadataBlob = new Blob([JSON.stringify(metadata)], { 
            type: 'application/json' 
        });
        formData.append('data', metadataBlob);

        await this.api.post(
            `/api/movies/chunk-upload/${this.uploadId}/chunks/${chunkNumber}`,
            formData
            // Note: Don't set Content-Type header manually, let browser handle multipart boundaries
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
