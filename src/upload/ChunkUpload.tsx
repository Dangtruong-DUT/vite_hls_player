import { useState, useRef } from 'react';
import { ChunkUploadService, type MovieMetadata } from './ChunkUploadService';

interface UploadState {
    status: 'idle' | 'uploading' | 'completed' | 'error';
    progress: number;
    uploadedChunks: number;
    totalChunks: number;
    uploadId: string | null;
    movieId: string | null;
    error: string | null;
}

function ChunkUpload() {
    const [file, setFile] = useState<File | null>(null);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [uploadState, setUploadState] = useState<UploadState>({
        status: 'idle',
        progress: 0,
        uploadedChunks: 0,
        totalChunks: 0,
        uploadId: null,
        movieId: null,
        error: null
    });
    
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploaderRef = useRef<ChunkUploadService | null>(null);
    const [dragActive, setDragActive] = useState(false);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (selectedFile) {
            setFile(selectedFile);
            setUploadState(prev => ({ ...prev, error: null }));
        }
    };

    const handleDrag = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            const droppedFile = e.dataTransfer.files[0];
            if (droppedFile.type.startsWith('video/')) {
                setFile(droppedFile);
                setUploadState(prev => ({ ...prev, error: null }));
            } else {
                setUploadState(prev => ({ 
                    ...prev, 
                    error: 'Vui lòng chọn file video' 
                }));
            }
        }
    };

    const handleUpload = async () => {
        if (!file || !title.trim()) {
            setUploadState(prev => ({ 
                ...prev, 
                error: 'Vui lòng chọn file và nhập tiêu đề' 
            }));
            return;
        }

        const metadata: MovieMetadata = {
            title: title.trim(),
            description: description.trim() || 'No description provided'
        };

        const uploader = new ChunkUploadService({
            onChunkUploaded: (chunkNumber, progress) => {
                setUploadState(prev => ({
                    ...prev,
                    progress,
                    uploadedChunks: chunkNumber + 1
                }));
            },
            onChunkRetry: (chunkNumber, error) => {
                console.error(`Chunk ${chunkNumber} failed:`, error);
            }
        });

        uploaderRef.current = uploader;

        try {
            setUploadState({
                status: 'uploading',
                progress: 0,
                uploadedChunks: 0,
                totalChunks: 0,
                uploadId: null,
                movieId: null,
                error: null
            });

            // Initiate upload
            const uploadId = await uploader.initiate(file, metadata);
            const totalChunks = uploader.getTotalChunks();
            
            setUploadState(prev => ({
                ...prev,
                uploadId,
                totalChunks
            }));

            // Upload all chunks
            await uploader.uploadAllChunks(file);

            // Check status
            const status = await uploader.checkStatus();
            console.log('Upload status:', status);

            if (status.missingChunks && status.missingChunks.length > 0) {
                throw new Error(`Missing chunks: ${status.missingChunks.join(', ')}`);
            }

            // Complete upload
            const result = await uploader.complete();
            console.log('Upload completed:', result);

            setUploadState(prev => ({
                ...prev,
                status: 'completed',
                movieId: result.movieId,
                progress: 100
            }));

        } catch (error) {
            console.error('Upload failed:', error);
            setUploadState(prev => ({
                ...prev,
                status: 'error',
                error: error instanceof Error ? error.message : 'Upload failed'
            }));
        }
    };

    const handleCancel = async () => {
        if (uploaderRef.current) {
            try {
                await uploaderRef.current.cancel();
            } catch (error) {
                console.error('Cancel failed:', error);
            }
        }
        
        setUploadState({
            status: 'idle',
            progress: 0,
            uploadedChunks: 0,
            totalChunks: 0,
            uploadId: null,
            movieId: null,
            error: null
        });
        setFile(null);
        setTitle('');
        setDescription('');
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleReset = () => {
        setUploadState({
            status: 'idle',
            progress: 0,
            uploadedChunks: 0,
            totalChunks: 0,
            uploadId: null,
            movieId: null,
            error: null
        });
        setFile(null);
        setTitle('');
        setDescription('');
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const formatFileSize = (bytes: number): string => {
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 Bytes';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
    };

    return (
        <div className="max-w-4xl mx-auto">
            <div className="bg-gradient-to-br from-white to-gray-50 rounded-2xl shadow-xl overflow-hidden border border-gray-200">
                {/* Header */}
                <div className="bg-gradient-to-r from-green-500 to-emerald-600 px-8 py-6">
                    <h2 className="text-3xl font-bold text-white flex items-center gap-3">
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        Upload Movie
                    </h2>
                    <p className="text-green-50 mt-2">Tải lên video của bạn để bắt đầu streaming</p>
                </div>

                <div className="p-8">
                    {uploadState.status === 'idle' && (
                        <div className="space-y-6">
                            {/* Drag & Drop File Upload */}
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-2">
                                    Video File
                                </label>
                                <div
                                    onDragEnter={handleDrag}
                                    onDragLeave={handleDrag}
                                    onDragOver={handleDrag}
                                    onDrop={handleDrop}
                                    className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200 ${
                                        dragActive 
                                            ? 'border-green-500 bg-green-50 scale-105' 
                                            : 'border-gray-300 hover:border-green-400 hover:bg-gray-50'
                                    }`}
                                >
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="video/*"
                                        onChange={handleFileChange}
                                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                    />
                                    
                                    {!file ? (
                                        <div className="space-y-3">
                                            <div className="flex justify-center">
                                                <svg className="w-16 h-16 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                                </svg>
                                            </div>
                                            <div>
                                                <p className="text-lg font-medium text-gray-700">
                                                    Kéo thả video vào đây
                                                </p>
                                                <p className="text-sm text-gray-500 mt-1">
                                                    hoặc click để chọn file
                                                </p>
                                            </div>
                                            <p className="text-xs text-gray-400">
                                                Hỗ trợ: MP4, AVI, MOV, MKV
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="space-y-3">
                                            <div className="flex justify-center">
                                                <svg className="w-16 h-16 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                                </svg>
                                            </div>
                                            <div>
                                                <p className="text-lg font-semibold text-gray-800">{file.name}</p>
                                                <p className="text-sm text-gray-500 mt-1">{formatFileSize(file.size)}</p>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setFile(null);
                                                    if (fileInputRef.current) fileInputRef.current.value = '';
                                                }}
                                                className="text-sm text-red-600 hover:text-red-700 font-medium"
                                            >
                                                Chọn file khác
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Title Input */}
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-2">
                                    Tiêu đề <span className="text-red-500">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    placeholder="Nhập tiêu đề phim..."
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all outline-none"
                                />
                            </div>

                            {/* Description Textarea */}
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-2">
                                    Mô tả
                                </label>
                                <textarea
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="Mô tả ngắn về phim (tùy chọn)..."
                                    rows={4}
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all outline-none resize-none"
                                />
                            </div>

                            {/* Upload Button */}
                            <button
                                onClick={handleUpload}
                                disabled={!file || !title.trim()}
                                className={`w-full py-4 rounded-lg font-bold text-lg transition-all duration-200 flex items-center justify-center gap-3 ${
                                    (!file || !title.trim())
                                        ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                        : 'bg-gradient-to-r from-green-500 to-emerald-600 text-white hover:from-green-600 hover:to-emerald-700 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5'
                                }`}
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                </svg>
                                Bắt đầu Upload
                            </button>

                            {/* Error Message */}
                            {uploadState.error && (
                                <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
                                    <svg className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                                    </svg>
                                    <div>
                                        <p className="font-semibold text-red-800">Lỗi</p>
                                        <p className="text-sm text-red-700">{uploadState.error}</p>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {uploadState.status === 'uploading' && (
                        <div className="space-y-6">
                            {/* Upload Info */}
                            <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 space-y-3">
                                <div className="flex items-center gap-3">
                                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                                    <h3 className="text-xl font-bold text-blue-900">Đang upload...</h3>
                                </div>
                                
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <p className="text-gray-600 font-medium">Upload ID</p>
                                        <p className="text-gray-900 font-mono text-xs mt-1 break-all">{uploadState.uploadId}</p>
                                    </div>
                                    <div>
                                        <p className="text-gray-600 font-medium">Tiến độ</p>
                                        <p className="text-gray-900 font-semibold mt-1">
                                            {uploadState.uploadedChunks} / {uploadState.totalChunks} chunks
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* Progress Bar */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <span className="text-sm font-semibold text-gray-700">Upload Progress</span>
                                    <span className="text-lg font-bold text-blue-600">{uploadState.progress}%</span>
                                </div>
                                <div className="w-full bg-gray-200 rounded-full h-6 overflow-hidden shadow-inner">
                                    <div
                                        className="bg-gradient-to-r from-blue-500 to-blue-600 h-full rounded-full transition-all duration-300 ease-out flex items-center justify-center"
                                        style={{ width: `${uploadState.progress}%` }}
                                    >
                                        {uploadState.progress > 10 && (
                                            <span className="text-xs font-bold text-white">{uploadState.progress}%</span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Cancel Button */}
                            <button
                                onClick={handleCancel}
                                className="w-full py-4 bg-red-500 hover:bg-red-600 text-white font-bold rounded-lg transition-all duration-200 flex items-center justify-center gap-3 shadow-lg hover:shadow-xl"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Hủy Upload
                            </button>
                        </div>
                    )}

                    {uploadState.status === 'completed' && (
                        <div className="space-y-6">
                            {/* Success Card */}
                            <div className="bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-300 rounded-xl p-8 text-center">
                                <div className="flex justify-center mb-4">
                                    <div className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center">
                                        <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                        </svg>
                                    </div>
                                </div>
                                
                                <h3 className="text-2xl font-bold text-green-800 mb-2">Upload thành công!</h3>
                                <p className="text-green-600 mb-6">Video của bạn đã được tải lên và sẵn sàng để streaming</p>
                                
                                <div className="bg-white rounded-lg p-6 space-y-4 text-left shadow-md">
                                    <div className="flex items-start gap-3">
                                        <svg className="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                        </svg>
                                        <div className="flex-1">
                                            <p className="text-sm font-semibold text-gray-600">Movie ID</p>
                                            <p className="text-base font-mono font-bold text-gray-900 break-all">{uploadState.movieId}</p>
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-start gap-3">
                                        <svg className="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                        </svg>
                                        <div className="flex-1">
                                            <p className="text-sm font-semibold text-gray-600">Upload ID</p>
                                            <p className="text-base font-mono text-gray-900 break-all">{uploadState.uploadId}</p>
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-start gap-3">
                                        <svg className="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                        </svg>
                                        <div className="flex-1">
                                            <p className="text-sm font-semibold text-gray-600">Số chunks đã upload</p>
                                            <p className="text-base font-bold text-gray-900">{uploadState.totalChunks} chunks</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* New Upload Button */}
                            <button
                                onClick={handleReset}
                                className="w-full py-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-bold rounded-lg transition-all duration-200 flex items-center justify-center gap-3 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                                Upload phim khác
                            </button>
                        </div>
                    )}

                    {uploadState.status === 'error' && (
                        <div className="space-y-6">
                            {/* Error Card */}
                            <div className="bg-gradient-to-br from-red-50 to-pink-50 border-2 border-red-300 rounded-xl p-8 text-center">
                                <div className="flex justify-center mb-4">
                                    <div className="w-20 h-20 bg-red-500 rounded-full flex items-center justify-center">
                                        <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </div>
                                </div>
                                
                                <h3 className="text-2xl font-bold text-red-800 mb-2">Upload thất bại!</h3>
                                <p className="text-red-600 mb-6">Đã xảy ra lỗi trong quá trình upload</p>
                                
                                <div className="bg-white rounded-lg p-6 text-left shadow-md">
                                    <div className="flex items-start gap-3">
                                        <svg className="w-6 h-6 text-red-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                                        </svg>
                                        <div className="flex-1">
                                            <p className="text-sm font-semibold text-gray-600 mb-2">Chi tiết lỗi:</p>
                                            <p className="text-base text-red-700 font-medium break-words">{uploadState.error}</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Retry Button */}
                            <button
                                onClick={handleReset}
                                className="w-full py-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white font-bold rounded-lg transition-all duration-200 flex items-center justify-center gap-3 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                            >
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                Thử lại
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default ChunkUpload;
