const results = document.querySelector('#results'),
  frames = ['a', 'b'].map((id) => document.getElementById(id));
const apps = () => frames.map((f) => f.contentWindow.Cwtch?.app);
const wait = async (fn, label) => {
  const end = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(label);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const pass = (label) => {
  results.textContent += '\n✓ ' + label;
};
document.getElementById('run').onclick = async () => {
  document.getElementById('run').disabled = true;
  results.textContent = 'Running…';
  try {
    await wait(() => apps().every((a) => a?.ui && a.identity), 'Player initialization');
    const [a, b] = apps();
    for (const app of [a, b]) app.settings.relayUrl = 'ws://127.0.0.1:8791/ws';
    await a.createRoom({ displayName: 'Sahil', roomName: 'Our kind of evening' });
    await wait(() => a.roomClient.joined, 'First connection');
    await b.setDisplayName('Alex');
    await b.joinRoom(JSON.parse(JSON.stringify(a.roomBundle)));
    await wait(
      () =>
        [a, b].every(
          (x) =>
            x.participants.size === 2 &&
            [...x.participants.values()].every((p) => p.name !== 'Connecting…'),
        ),
      'Presence handshake',
    );
    pass('Two participants connected and authenticated');
    await a.sendChat('Ready when you are. ♡');
    await wait(
      () => b.ui.messages.length === 1 && a.ui.messages[0].status === 'delivered',
      'Chat delivery',
    );
    pass('Encrypted chat delivered and acknowledged');
    a.media.currentTime = 42;
    await wait(() => Math.abs(b.media.currentTime - 42) < 0.1, 'Seek synchronization');
    pass('Seek synchronized');
    await b.syncEngine.resumeTogether();
    await wait(() => !a.media.paused, 'Remote playback');
    pass('Playback synchronized');
    await a.saveMoment('This is the scene.');
    await wait(() => b.ui.moments.length === 1, 'Moment sharing');
    pass('Timestamped moment shared');
    a.ui.nextPrompt();
    await wait(() => b.ui.promptIndex === a.ui.promptIndex, 'Prompt sharing');
    pass('Both participants see the same prompt');
    a.ui.open('room');
    b.ui.open('room');
    await a.leaveRoom();
    await wait(() => b.participants.size === 1 && b.syncEngine.isLeader(), 'Leadership transfer');
    pass('Remaining participant becomes sync leader');
    if (a.ui.messages.length) throw new Error('Room history leaked after leaving');
    pass('Leaving clears the room interface');
    await b.roomClient.retryNow();
    await wait(() => b.roomClient.joined, 'Reconnect');
    pass('Reconnect handshake succeeds');
    await a.joinRoom(JSON.parse(JSON.stringify(b.roomBundle)));
    await wait(() => a.roomClient.joined && b.participants.size === 2, 'Rejoin');
    await a.sendChat('A little closer, wherever we are.');
    await wait(() => a.ui.messages.at(-1).status === 'delivered', 'Rejoin delivery');
    a.ui.open('room');
    b.ui.open('room');
    results.textContent += '\nALL SCENARIO CHECKS PASSED';
  } catch (error) {
    results.textContent += '\nFAILED: ' + error.message;
    console.error(error);
  }
};
for (const name of ['chat', 'room', 'moments'])
  document.getElementById(name).onclick = () => apps().forEach((app) => app.ui.open(name));
