/**
 * Streaming Player Demo Component
 * Demonstrates full video streaming using StreamingPlayerCoordinator
 */

import { useEffect, useRef, useState } from 'react';
import { StreamingPlayerCoordinator } from './StreamingPlayerCoordinator';

interface StreamingPlayerDemoProps {
  clientId: string;
  movieId?: string;
}

export default function StreamingPlayerDemo({ clientId, movieId = '3a044ac7-70c6-491f-9467-5eddc06d58b2' }: StreamingPlayerDemoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<StreamingPlayerCoordinator | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentQuality, setCurrentQuality] = useState<string>('auto');
  const [availableQualities, setAvailableQualities] = useState<string[]>([]);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [inputMovieId, setInputMovieId] = useState(movieId);

  useEffect(() => {
    if (!videoRef.current) return;

    // Initialize player
    const player = new StreamingPlayerCoordinator({
      movieId: inputMovieId,
      clientId,
      videoElement: videoRef.current,
      signalingUrl: import.meta.env.VITE_SIGNALING_WS_URL || 'ws://localhost:8083/ws/signaling', // Use env var or default
    });

    playerRef.current = player;

    // Initialize the player asynchronously
    const initPlayer = async () => {
      try {
        await player.initialize();
        console.log('Player initialized successfully');
      } catch (error) {
        console.error('Failed to initialize player:', error);
        setError(`Failed to initialize player: ${error}`);
      }
    };

    initPlayer();

    // Set up video element event listeners
    const video = videoRef.current;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleWaiting = () => setIsBuffering(true);
    const handleCanPlay = () => setIsBuffering(false);
    const handleError = () => setError('Video playback error');
    const handleTimeUpdate = () => {
      if (!video) return;
      setCurrentTime(video.currentTime || 0);
    };
    const handleLoadedMeta = () => {
      if (!video) return;
      setDuration(video.duration || 0);
      setCurrentTime(video.currentTime || 0);
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('error', handleError);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleLoadedMeta);

    // Player events
    player.on('ready', () => {
      // populate available qualities when player is ready
      try {
        const quals = player.getAvailableQualities();
        setAvailableQualities(quals.map(q => q.id));
        const cur = player.getCurrentQuality();
        setCurrentQuality(cur ? cur.id : 'auto');
      } catch (e) {
        // ignore
      }
    });

    player.on('qualityChanged', (quality) => {
      setCurrentQuality(quality.id);
    });

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('error', handleError);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleLoadedMeta);

      player.dispose();
    };
  }, [inputMovieId, clientId]);

  const handlePlayPause = () => {
    if (!videoRef.current) return;

    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
  };

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;

    const time = parseFloat(event.target.value);
    // Use coordinator seek for cache-aware prefetch if available
    if (playerRef.current) {
      playerRef.current.seek(time).catch(() => {
        // fallback to directly setting time
        if (videoRef.current) videoRef.current.currentTime = time;
      });
    } else {
      videoRef.current.currentTime = time;
    }
  };

  const handleMovieIdChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputMovieId(event.target.value);
  };

  return (
    <div className="p-6">
      <div className="max-w-4xl mx-auto">
        {/* Video Player */}
        <div className="bg-black rounded-lg overflow-hidden mb-4">
          <video
            ref={videoRef}
            className="w-full h-auto"
            controls={false}
            poster="/api/placeholder/800/450"
          />
        </div>

        {/* Controls */}
        <div className="bg-gray-100 rounded-lg p-4">
          {/* Movie ID Input */}
          <div className="mb-4">
            <label htmlFor="movieId" className="block text-sm font-medium text-black mb-2">
              Movie ID
            </label>
            <input
              id="movieId"
              type="text"
              value={inputMovieId}
              onChange={handleMovieIdChange}
              className="w-full px-3 py-2 bg-white text-black border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter movie ID"
            />
          </div>

          <div className="flex items-center justify-between mb-4">
            <button
              onClick={handlePlayPause}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              disabled={isBuffering}
            >
              {isBuffering ? '⏳ Buffering...' : isPlaying ? '⏸️ Pause' : '▶️ Play'}
            </button>

            <div className="text-sm text-gray-600 flex items-center space-x-3">
              <div>Quality:</div>
              <select
                value={currentQuality}
                onChange={(e) => {
                  const val = e.target.value;
                  if (!playerRef.current) return;
                  if (val === 'auto') {
                    playerRef.current.enableAutoQuality();
                    setCurrentQuality('auto');
                  } else {
                    // set manual quality
                    playerRef.current.setManualQuality(val).catch(err => console.error(err));
                  }
                }}
                className="px-2 py-1 border rounded bg-white text-black"
              >
                <option value="auto">Auto</option>
                {availableQualities.map(q => (
                  <option key={q} value={q}>{q}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Seek Bar */}
          <div className="mb-4">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step="0.1"
              value={currentTime}
              onChange={handleSeek}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="mt-4 text-sm text-gray-600">
          <p><strong>Movie ID:</strong> {inputMovieId}</p>
          <p><strong>Client ID:</strong> {clientId}</p>
          <p><strong>Signaling URL:</strong> {import.meta.env.VITE_SIGNALING_WS_URL || 'ws://localhost:8083/ws/signaling'}</p>
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}