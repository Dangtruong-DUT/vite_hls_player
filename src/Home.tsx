import { useState } from "react";
import TabNavigation from './TabNavigation';
import StreamingSection from './StreamingSection';
import ChunkUpload from './upload/ChunkUpload';

function Home() {
    const [clientId] = useState(() => `viewer-${crypto.randomUUID().slice(0, 8)}`);
    const [activeTab, setActiveTab] = useState<'upload' | 'streaming'>('streaming');

    return (
        <div className="min-h-screen bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-600">
            {/* Tab Navigation */}
            <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />

            {/* Upload Section */}
            {activeTab === 'upload' && (
                <div className="animate-in slide-in-from-top p-6">
                    <ChunkUpload />
                </div>
            )}

            {/* Streaming Section */}
            {activeTab === 'streaming' && (
                <div className="animate-in slide-in-from-top">
                    <StreamingSection clientId={clientId} />
                </div>
            )}
        </div>
    );
}

export default Home;

