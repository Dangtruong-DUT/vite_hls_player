/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal page with Hls.js + WebRTC-enhanced loader
import { useEffect, useRef, useState } from "react";
import Hls from 'hls.js';
import HlsWebRtcLoader from './streaming/HlsWebRtcLoader';
import { defaultStreamingConfig } from './streaming/config';
import ChunkUpload from './upload/ChunkUpload';

function Home() {
    const [hlsUrl, setHlsUrl] = useState("http://localhost:3000/api/static/video-hls/jMfRtmXNuQGiuQ-O4XBSF/master.m3u8");
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [clientId] = useState(() => `viewer-${crypto.randomUUID().slice(0,8)}`);
    const [streamId, setStreamId] = useState("jMfRtmXNuQGiuQ-O4XBSF_720p");
    const [activeTab, setActiveTab] = useState<'upload' | 'streaming'>('upload');

    useEffect(() => {
        if (activeTab !== 'streaming') return;
        
        const el = videoRef.current;
        if (!el) return;
        if (Hls.isSupported()) {
            // Create custom loader by cloning default and overriding load method.
            const BaseLoader = (Hls as any).DefaultConfig.loader;
            class HybridLoader {
                private inner: any;
                public stats: any;
                public context: any;
                constructor(config: any) {
                    this.inner = new BaseLoader(config);
                    this.stats = this.inner.stats;
                }
                load(context: any, config: any, callbacks: any) {
                    this.context = context;
                    if (context.type === 'fragment') {
                        const loader = HlsWebRtcLoader.ensure(defaultStreamingConfig.signalingUrl, clientId, streamId);
                        return loader.load(context, config, callbacks);
                    }
                    return this.inner.load(context, config, callbacks);
                }
                abort() { if (this.inner?.abort) this.inner.abort(); }
                destroy() { if (this.inner?.destroy) this.inner.destroy(); }
            }
            const hls = new Hls({ loader: HybridLoader as any });
            hls.loadSource(hlsUrl);
            hls.attachMedia(el);
            return () => { hls.destroy(); };
        } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
            el.src = hlsUrl;
        }
    }, [hlsUrl, clientId, streamId, activeTab]);

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-blue-50 to-green-50 p-6">
            {/* Tab Navigation */}
            <div className="max-w-6xl mx-auto mb-8">
                <div className="bg-white rounded-2xl shadow-lg p-2 flex gap-2">
                    <button
                        onClick={() => setActiveTab('upload')}
                        className={`flex-1 py-4 px-6 rounded-xl font-bold text-base transition-all duration-300 flex items-center justify-center gap-3 ${
                            activeTab === 'upload'
                                ? 'bg-gradient-to-r from-green-500 to-emerald-600 text-white shadow-lg transform scale-105'
                                : 'bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-800'
                        }`}
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        Upload Movie
                    </button>
                    <button
                        onClick={() => setActiveTab('streaming')}
                        className={`flex-1 py-4 px-6 rounded-xl font-bold text-base transition-all duration-300 flex items-center justify-center gap-3 ${
                            activeTab === 'streaming'
                                ? 'bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-lg transform scale-105'
                                : 'bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-800'
                        }`}
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        HLS Streaming
                    </button>
                </div>
            </div>

            {/* Upload Section */}
            {activeTab === 'upload' && (
                <div className="animate-fadeIn">
                    <ChunkUpload />
                </div>
            )}

            {/* Streaming Section */}
            {activeTab === 'streaming' && (
                <div className="max-w-6xl mx-auto">
                    <div className="bg-gradient-to-br from-white to-gray-50 rounded-2xl shadow-xl overflow-hidden border border-gray-200">
                        {/* Header */}
                        <div className="bg-gradient-to-r from-blue-500 to-indigo-600 px-8 py-6">
                            <h2 className="text-3xl font-bold text-white flex items-center gap-3">
                                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                HLS Streaming với WebRTC
                            </h2>
                            <p className="text-blue-50 mt-2">Phát video HLS với tăng tốc WebRTC P2P</p>
                        </div>

                        <div className="p-8 space-y-6">
                            {/* Configuration Section */}
                            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-200">
                                <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
                                    <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                    Cấu hình Stream
                                </h3>
                                
                                <div className="space-y-4">
                                    {/* HLS URL Input */}
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-2">
                                            HLS URL
                                        </label>
                                        <div className="relative">
                                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                                </svg>
                                            </div>
                                            <input 
                                                type="text" 
                                                value={hlsUrl}
                                                onChange={(e) => setHlsUrl(e.target.value)}
                                                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none bg-white"
                                                placeholder="https://example.com/video/master.m3u8"
                                            />
                                        </div>
                                        <p className="mt-2 text-xs text-gray-500 flex items-center gap-1">
                                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                                            </svg>
                                            Nhập URL của file master.m3u8 hoặc playlist.m3u8
                                        </p>
                                    </div>

                                    {/* Stream ID Input */}
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-2">
                                            Stream ID (movieId_quality)
                                        </label>
                                        <div className="relative">
                                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                                                </svg>
                                            </div>
                                            <input
                                                type="text"
                                                value={streamId}
                                                onChange={(e) => setStreamId(e.target.value)}
                                                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none bg-white"
                                                placeholder="jMfRtmXNuQGiuQ-O4XBSF_720p"
                                            />
                                        </div>
                                        <p className="mt-2 text-xs text-gray-500 flex items-center gap-1">
                                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                                            </svg>
                                            Format: movieId_quality (ví dụ: abc123_720p, xyz456_1080p)
                                        </p>
                                    </div>

                                    {/* Client ID Display */}
                                    <div className="pt-2 border-t border-blue-200">
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-medium text-gray-600">Client ID:</span>
                                            <span className="text-sm font-mono font-semibold text-blue-700 bg-white px-3 py-1 rounded-md border border-blue-200">
                                                {clientId}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Video Player Section */}
                            <div className="space-y-3">
                                <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                                    <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                    Video Player
                                </h3>
                                
                                <div className="relative rounded-xl overflow-hidden shadow-2xl bg-black" style={{ aspectRatio: '16/9' }}>
                                    {/* Video Element */}
                                    <video 
                                        ref={videoRef} 
                                        className="w-full h-full"
                                        controls 
                                        playsInline
                                        poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25' viewBox='0 0 800 450'%3E%3Crect fill='%23000000' width='800' height='450'/%3E%3Cg fill='%23ffffff' fill-opacity='0.1'%3E%3Cpath d='M400 225L450 275L400 325L350 275Z'/%3E%3Ccircle cx='400' cy='225' r='100' stroke='%23ffffff' stroke-width='2' fill='none' stroke-opacity='0.3'/%3E%3C/g%3E%3C/svg%3E"
                                    />
                                    
                                    {/* Loading Overlay (optional) */}
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent pointer-events-none"></div>
                                </div>

                                {/* Video Info */}
                                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                                        <div className="flex items-center gap-2">
                                            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                                            <span className="font-medium text-gray-700">WebRTC Enhanced</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                            </svg>
                                            <span className="text-gray-600">HLS Protocol</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                            </svg>
                                            <span className="text-gray-600">P2P Streaming</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default Home;

