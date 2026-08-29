// call.js — P2P Video Call (WebRTC)
//
// Flow:
//  1. Both people open the app and enter the same room code.
//  2. The server (Socket.IO) tells each browser about the other and
//     relays the WebRTC handshake (offer/answer/ICE candidates) —
//     the server never sees or touches the actual video/audio.
//  3. Once the handshake completes, video flows either directly
//     between the two devices (P2P) or, if a direct connection isn't
//     possible (common across different carrier networks like Globe
//     mobile data vs. WiFi — this is what causes the "black screen"
//     problem), through a TURN relay server instead.

let socket = null;
let peerConnection = null;
let localStream = null;
let currentRoom = null;
let remotePeerId = null;
let micEnabled = true;
let camEnabled = true;

async function joinCallRoom() {
  const roomCode = document.getElementById('roomCodeInput').value.trim();
  const statusEl = document.getElementById('callStatus');

  if (!roomCode) {
    statusEl.textContent = 'Maglagay muna ng room code.';
    return;
  }

  statusEl.textContent = 'Hinihingi ang access sa camera/mic...';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    statusEl.textContent = 'Hindi ma-access ang camera/mic: ' + err.message;
    return;
  }

  document.getElementById('localVideo').srcObject = localStream;
  document.getElementById('callSetup').classList.add('hidden');
  document.getElementById('callActive').classList.remove('hidden');
  document.getElementById('remoteLabel').textContent = 'Hinihintay ang kausap...';

  socket = io();
  currentRoom = roomCode;

  socket.on('connect', () => {
    socket.emit('join-room', roomCode);
  });

  socket.on('room-full', () => {
    endCall();
    document.getElementById('callStatus').textContent =
      'Puno na ang room na iyon (2 lang ang max). Gumamit ng ibang code.';
  });

  socket.on('joined-room', async ({ initiator, peers }) => {
    if (peers.length > 0) {
      remotePeerId = peers[0];
      await setupPeerConnection();
      if (initiator) {
        // Shouldn't normally happen (initiator implies no peers), kept for safety.
      }
    }
  });

  socket.on('peer-joined', async ({ peerId }) => {
    remotePeerId = peerId;
    await setupPeerConnection();
    // The one who was already in the room creates the offer.
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { to: remotePeerId, data: { type: 'offer', sdp: offer } });
  });

  socket.on('signal', async ({ from, data }) => {
    if (!peerConnection) await setupPeerConnection();
    remotePeerId = from;

    if (data.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice-candidate' && data.candidate) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn('Failed to add ICE candidate', e);
      }
    }
  });

  socket.on('peer-left', () => {
    document.getElementById('remoteLabel').textContent = 'Umalis ang kausap';
    document.getElementById('remoteVideo').srcObject = null;
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
  });
}

async function setupPeerConnection() {
  const resp = await fetch('/api/turn-credentials');
  const { iceServers } = await resp.json();

  peerConnection = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      document.getElementById('remoteLabel').textContent = 'Nakakonekta';
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && remotePeerId) {
      socket.emit('signal', {
        to: remotePeerId,
        data: { type: 'ice-candidate', candidate: event.candidate }
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const label = document.getElementById('remoteLabel');
    if (peerConnection.connectionState === 'connected') {
      label.textContent = 'Nakakonekta';
    } else if (peerConnection.connectionState === 'failed') {
      label.textContent = 'Nabigo ang koneksyon — subukan ulit';
    } else if (peerConnection.connectionState === 'disconnected') {
      label.textContent = 'Nadiskonekta';
    }
  };
}

function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = document.getElementById('toggleMicBtn');
  btn.innerHTML = micEnabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
}

function toggleCam() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById('toggleCamBtn');
  btn.innerHTML = camEnabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
}

function endCall() {
  if (socket) {
    socket.emit('leave-room');
    socket.disconnect();
    socket = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('remoteVideo').srcObject = null;
  document.getElementById('callActive').classList.add('hidden');
  document.getElementById('callSetup').classList.remove('hidden');
  document.getElementById('callStatus').textContent = '';
  document.getElementById('roomCodeInput').value = '';
  currentRoom = null;
  remotePeerId = null;
}

window.joinCallRoom = joinCallRoom;
window.toggleMic = toggleMic;
window.toggleCam = toggleCam;
window.endCall = endCall;
    
