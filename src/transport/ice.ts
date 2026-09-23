export function getDefaultIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    // Primary High-Availability STUN
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  // Check if custom TURN credentials are provided via environment
  const customTurnUrl = import.meta.env?.VITE_TURN_URL;
  const customTurnUser = import.meta.env?.VITE_TURN_USERNAME;
  const customTurnPass = import.meta.env?.VITE_TURN_CREDENTIAL;

  if (customTurnUrl && customTurnUser && customTurnPass) {
    servers.push({
      urls: customTurnUrl.split(','),
      username: customTurnUser,
      credential: customTurnPass,
    });
  } else {
    // Default OpenRelay TURN - UDP & TCP fallback (Ports 80 & 443)
    servers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:80?transport=tcp',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });

    // Secure TURNS fallback (TLS over TCP 443 for strict enterprise firewalls)
    servers.push({
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    });
  }

  return servers;
}
