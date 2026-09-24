export const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    // Google Public STUN
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },

    // Cloudflare Public STUN
    { urls: 'stun:stun.cloudflare.com:3478' },

    // OpenRelay Public TURN (UDP Port 80 & 443) - Traverses symmetric CGNAT
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelay',
      credential: 'openrelay'
    }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  iceTransportPolicy: 'all'
};

export const rtcConfiguration: RTCConfiguration = ICE_SERVERS;
export const defaultIceServers = ICE_SERVERS.iceServers;

export function getDefaultIceServers(): RTCIceServer[] {
  return (ICE_SERVERS.iceServers as RTCIceServer[]) || [];
}