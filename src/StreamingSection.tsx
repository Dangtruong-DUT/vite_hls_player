/**
 * StreamingSection Component
 * Displays streaming player with examples and demos
 */

import { useState } from 'react';
import StreamingPlayerDemo from './streaming/StreamingPlayerDemo';

interface StreamingSectionProps {
  clientId: string;
}

type DemoTab = 'player';

export default function StreamingSection({ clientId }: StreamingSectionProps) {
  const [activeDemo, setActiveDemo] = useState<DemoTab>('player');

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 mb-6 text-white">
          <h1 className="text-3xl font-bold mb-2">🎥 Streaming Player Demos</h1>
          <p className="text-white/80">
            Interactive demos for video streaming, CacheManager, and BufferManager
          </p>
          <p className="text-sm text-white/60 mt-2">Client ID: {clientId}</p>
        </div>

        {/* Demo Tabs */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setActiveDemo('player')}
            className={`px-6 py-3 rounded-lg font-semibold transition ${
              activeDemo === 'player'
                ? 'bg-white text-purple-600 shadow-lg'
                : 'bg-white/20 text-white hover:bg-white/30'
            }`}
          >
            🎬 Video Player
          </button>
        </div>

        {/* Demo Content */}
        <div className="bg-white rounded-lg shadow-xl overflow-hidden">
          {activeDemo === 'player' && <StreamingPlayerDemo clientId={clientId} />}
        </div>
      </div>
    </div>
  );
}
