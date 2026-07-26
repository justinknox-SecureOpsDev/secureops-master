import { useVideoPlayer } from '@/lib/video';
import { VideoStage, type Caption } from './VideoStage';
import { GOLD } from './RadioShared';

import { SceneTrainingIntro } from './SceneTrainingIntro';
import { SceneTrainingShifts } from './SceneTrainingShifts';
import { SceneTrainingClaim } from './SceneTrainingClaim';
import { SceneTrainingClock } from './SceneTrainingClock';
import { SceneTrainingConfirm } from './SceneTrainingConfirm';
import { SceneTrainingOutro } from './SceneTrainingOutro';

const SCENE_DURATIONS = {
  intro: 4000,
  shifts: 6000,
  claim: 7000,
  clock: 8500,
  confirm: 7500,
  outro: 8000,
};

const CAPTIONS: Caption[] = [
  {
    step: 'Welcome',
    title: 'SecureOps Mobile',
    body: 'A quick-start guide to the tools you need on shift.',
  },
  {
    step: 'Step 1',
    title: 'View your shifts',
    body: 'Check your schedule, find shift details, and see estimated pay at a glance.',
  },
  {
    step: 'Step 2',
    title: 'Claim open slots',
    body: 'Browse available shifts near you and request slots instantly. Your dispatcher will confirm.',
  },
  {
    step: 'Step 3',
    title: 'Clock in on site',
    body: 'When you arrive, clock in with one tap. GPS confirms your location automatically.',
  },
  {
    step: 'Step 4',
    title: 'Confirm your time',
    body: 'After your shift, review your hours and submit them directly to payroll. No paper sheets.',
  },
  {
    step: 'And more',
    title: 'Everything you need',
    body: 'From SOS alerts to live team chat and ops plans, your phone is your command center.',
  },
];

export default function VideoTemplateTraining() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });
  
  return (
    <VideoStage scene={currentScene} caption={CAPTIONS[currentScene]} accent={GOLD}>
      {currentScene === 0 && <SceneTrainingIntro key="intro" />}
      {currentScene === 1 && <SceneTrainingShifts key="shifts" />}
      {currentScene === 2 && <SceneTrainingClaim key="claim" />}
      {currentScene === 3 && <SceneTrainingClock key="clock" />}
      {currentScene === 4 && <SceneTrainingConfirm key="confirm" />}
      {currentScene === 5 && <SceneTrainingOutro key="outro" />}
    </VideoStage>
  );
}
