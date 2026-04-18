"use client";

import React, { useRef } from "react";
import { useStreamSession } from "@/hooks/useStreamSession";

export default function VideoViewer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  const { isConnected, error, networkQuality, startStream, stopStream } = useStreamSession({
    payload: { type: "monitoring", cameraId: "test_cam_1" },
    autoStart: true,
    videoRef,
  });

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4">
      <h1 className="text-2xl font-bold mb-6">Live Stream Monitor</h1>
      
      <div className="relative w-full max-w-5xl aspect-video bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800">
        <video
          id="live"
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-contain"
        />
        
        {/* Connection Status Overlay */}
        <div className="absolute top-4 left-4 flex flex-col gap-2">
          <div className={`px-3 py-1 rounded-full text-sm font-medium ${
            isConnected ? 'bg-green-500/20 text-green-400' :
            error ? 'bg-red-500/20 text-red-400' :
            'bg-yellow-500/20 text-yellow-400'
          }`}>
            <span className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : error ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'}`}></span>
              {isConnected ? "Connected" : error ? "Error" : "Connecting..."}
            </span>
          </div>
          
          {isConnected && (
            <div className="px-3 py-1 rounded-full text-sm font-medium bg-zinc-800/80 text-zinc-300">
              Quality: {networkQuality}
            </div>
          )}
        </div>
        
        {/* Error State */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <p className="text-red-400 max-w-md text-center bg-zinc-900 p-4 rounded">{error}</p>
          </div>
        )}
      </div>
      
      <div className="flex gap-4 mt-8">
        <button 
          onClick={startStream} 
          disabled={isConnected}
          className="px-6 py-2 rounded font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {error ? "Retry Connection" : "Start Stream"}
        </button>
        <button 
          onClick={stopStream}
          disabled={!isConnected} 
          className="px-6 py-2 rounded font-medium bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Stop Stream
        </button>
      </div>
    </div>
  );
}
