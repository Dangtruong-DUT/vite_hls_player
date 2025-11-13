interface TabNavigationProps {
    activeTab: 'upload' | 'streaming';
    onTabChange: (tab: 'upload' | 'streaming') => void;
}

function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
    return (
        <div className="max-w-6xl mx-auto mb-8">
            <div className="bg-white rounded-2xl shadow-lg p-2 flex gap-2">
                <button
                    onClick={() => onTabChange('upload')}
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
                    onClick={() => onTabChange('streaming')}
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
    );
}

export default TabNavigation;
