export interface PeerMetrics { uploadSpeed?: number; latency?: number; successRate?: number }
export interface PeerInfo { peerId: string; metrics?: PeerMetrics }
export interface ScoringWeights { alphaSpeed?: number; betaLatency?: number; gammaReliability?: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
function numeric(value: any, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function scorePeers(peers: PeerInfo[], weights: ScoringWeights) {
  const alpha = weights.alphaSpeed ?? 0.6;
  const beta = weights.betaLatency ?? 0.002;
  const gamma = weights.gammaReliability ?? 0.4;
  return peers
    .map((peer) => {
      const metrics = peer.metrics || {};
      const uploadSpeed = numeric(metrics.uploadSpeed);
      const latency = numeric(metrics.latency, 999);
      const reliability = numeric(metrics.successRate, 0.5);
      const score = alpha * uploadSpeed - beta * latency + gamma * reliability;
      return {
        ...peer,
        metrics: { uploadSpeed, latency, successRate: reliability },
        score
      };
    })
    .sort((a, b) => b.score - a.score);
}
