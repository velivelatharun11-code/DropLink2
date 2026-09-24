export const rtcConfiguration: RTCConfiguration = {
  iceServers: [
    // Google Public STUN
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },

    // Cloudflare Public STUN
    { urls: 'stun:stun.cloudflare.com:3478' },

    // OpenRelay Public TURN (UDP Port 80 & 443)
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },

    // OpenRelay Public TURN (TCP Port 443 - Traverses hotspot & cellular firewalls)
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  iceTransportPolicy: 'all'
};

export const defaultIceServers = rtcConfiguration.iceServers;

export function getDefaultIceServers(): RTCIceServer[] {
  return (rtcConfiguration.iceServers as RTCIceServer[]) || [];
}