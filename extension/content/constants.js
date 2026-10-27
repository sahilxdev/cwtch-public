(() => {
  'use strict';
  const C = globalThis.Cwtch;

  C.PROTOCOL_VERSION = CwtchProtocol.version;
  C.APP_VERSION = CwtchProtocol.appVersion;
  C.DEFAULT_SETTINGS = CwtchProtocol.defaults;
  C.SYNC = Object.freeze({
    heartbeatMs: 3000,
    hardSeekThresholdSeconds: 1.1,
    softSeekThresholdSeconds: 0.28,
    maxSoftRateDelta: 0.04,
    softCorrectionMs: 4200,
    applyGuardMs: 900,
    maxReconnectAttempts: 12,
  });
  C.DATE_PROMPTS = Object.freeze([
    'Choose one scene you would keep if the rest of the film disappeared.',
    'Pause after the next big decision. Guess what each character will do.',
    'Pick the snack this film deserves, not the snack you already have.',
    'Name the tiny detail you noticed first about the person on screen.',
    'At the credits, each choose one line worth stealing for real life.',
    'Choose the next watch by mood only: tender, strange, funny, or reckless.',
    'One of you picks the film. The other chooses the lights, drinks, and snacks.',
    'Before the ending, each privately predict the final shot. Reveal together.',
    'Save one timestamp that you will both remember a month from now.',
    'After the credits, give the film a title that tells the truth about it.',
    'Choose one character you would trust with your house keys.',
    'Pick the scene that would make the best first page of a novel.',
  ]);
  C.REACTIONS = Object.freeze(['♡', '😂', '😮', '🥺', '🔥', '👀']);
})();
