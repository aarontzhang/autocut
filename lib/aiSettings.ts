import type { AIEditingSettings, TransitionType } from './types';

export const DEFAULT_AI_EDITING_SETTINGS: AIEditingSettings = {
  silenceRemoval: {
    paddingSeconds: 0,
    minDurationSeconds: 0.5,
    preserveShortPauses: true,
    requireSpeakerAbsence: true,
  },
  captions: {
    wordsPerCaption: 4,
  },
  transitions: {
    defaultDuration: 1,
    defaultType: 'fade_black',
  },
  textOverlays: {
    defaultPosition: 'bottom',
    defaultFontSize: 16,
  },
};
