import { useVideoPlayer } from '@/lib/video';
import { motion } from 'framer-motion';
import { Mic } from 'lucide-react';
import { VideoStage, type Caption } from './VideoStage';
import { Pointer } from './Shared';
import {
  RadioScreen,
  StatusBanner,
  Waveform,
  PTTButton,
  LockScreen,
  OngoingNotification,
  GREEN,
} from './RadioShared';

const SCENE_DURATIONS = {
  channel: 6000,
  transmit: 8000,
  background: 7000,
};

const CAPTIONS: Caption[] = [
  {
    step: 'Step 1',
    title: 'Officer opens the two-way radio',
    body: 'A red push-to-talk button waits on the channel screen, ready for the officer to speak.',
    pill: 'On screen',
  },
  {
    step: 'Step 2',
    title: 'Press and hold to transmit',
    body: "Holding the button captures the officer's voice and sends it to the team — using the microphone foreground service.",
    pill: 'FOREGROUND_SERVICE_MICROPHONE',
  },
  {
    step: 'Step 3',
    title: 'Transmit hands-free in the background',
    body: 'Push-to-talk keeps working even when the app is backgrounded or the screen is locked.',
    pill: 'Background audio input',
  },
];

const SceneChannel = () => (
  <motion.div
    className="absolute inset-0"
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.5 }}
  >
    <RadioScreen
      channelName="Dispatch"
      siteName="Nexus Industrial Park"
      banner={<StatusBanner kind="idle" />}
      waveform={<Waveform color="#52525b" active={false} bars={26} className="h-12" />}
      ptt={<PTTButton state="idle" />}
    />
  </motion.div>
);

const SceneTransmit = () => (
  <motion.div
    className="absolute inset-0"
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.5 }}
  >
    <RadioScreen
      channelName="Dispatch"
      siteName="Nexus Industrial Park"
      banner={<StatusBanner kind="transmitting" />}
      waveform={<Waveform color={GREEN} active bars={26} className="h-12" />}
      ptt={<PTTButton state="transmitting" pressed />}
    />
    <Pointer x="50%" y="80%" active show />
  </motion.div>
);

const SceneBackground = () => (
  <motion.div
    className="absolute inset-0"
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.5 }}
  >
    <LockScreen>
      <OngoingNotification
        accent={GREEN}
        icon={<Mic className="w-3.5 h-3.5 text-white" />}
        title="On air — transmitting"
        subtitle="Push-to-talk · Dispatch channel"
        pill="MIC LIVE"
        waveformColor={GREEN}
      />
    </LockScreen>
  </motion.div>
);

export default function VideoTemplateMic() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });
  return (
    <VideoStage scene={currentScene} caption={CAPTIONS[currentScene]} accent={GREEN}>
      {currentScene === 0 && <SceneChannel key="channel" />}
      {currentScene === 1 && <SceneTransmit key="transmit" />}
      {currentScene === 2 && <SceneBackground key="bg" />}
    </VideoStage>
  );
}
