import { useVideoPlayer } from '@/lib/video';
import { motion } from 'framer-motion';
import { Radio } from 'lucide-react';
import { VideoStage, type Caption } from './VideoStage';
import {
  RadioScreen,
  StatusBanner,
  Waveform,
  PTTButton,
  LockScreen,
  OngoingNotification,
  BRAND_BG,
  GOLD,
  BLUE,
} from './RadioShared';

const SCENE_DURATIONS = {
  listen: 7000,
  background: 8000,
  confirm: 6000,
};

const CAPTIONS: Caption[] = [
  {
    step: 'Step 1',
    title: 'Officer joins a live radio channel',
    body: 'On shift, the officer opens the two-way radio and hears their team and dispatch in real time.',
    pill: 'On screen',
  },
  {
    step: 'Step 2',
    title: 'Audio keeps playing when the screen is off',
    body: 'The phone locks, but incoming transmissions keep coming through — sustained by the media-playback foreground service.',
    pill: 'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  },
  {
    step: 'Step 3',
    title: 'Officers never miss a call',
    body: 'The radio stays live in the background so an officer always hears dispatch, even mid-patrol.',
    pill: 'Background audio',
  },
];

const SceneListen = () => (
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
      banner={<StatusBanner kind="other" name="Unit 4 · Rivera" />}
      waveform={<Waveform color={BLUE} active bars={26} className="h-12" />}
      ptt={<PTTButton state="idle" />}
    />
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
        accent={GOLD}
        icon={<Radio className="w-3.5 h-3.5 text-black" />}
        title="Playing — Dispatch channel"
        subtitle="Unit 4 · Rivera is transmitting"
        pill="LIVE"
        waveformColor={GOLD}
      />
    </LockScreen>
  </motion.div>
);

const SceneConfirm = () => (
  <motion.div
    className="absolute inset-0 flex flex-col items-center justify-center px-8"
    style={{ backgroundColor: BRAND_BG }}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.6 }}
  >
    <motion.div
      className="w-24 h-24 rounded-3xl flex items-center justify-center mb-8"
      style={{ backgroundColor: `${GOLD}1a`, border: `1px solid ${GOLD}44` }}
      initial={{ scale: 0, rotate: -20 }}
      animate={{ scale: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.2 }}
    >
      <Radio className="w-12 h-12" style={{ color: GOLD }} />
    </motion.div>
    <Waveform color={GOLD} active bars={22} className="h-10 mb-8" />
    <h1 className="text-white text-2xl font-extrabold text-center leading-tight mb-3">
      Radio audio continues
      <br />
      in the background
    </h1>
    <p className="text-white/50 text-center text-sm max-w-[16rem]">
      SecureOps keeps the channel live so officers never miss a transmission.
    </p>
  </motion.div>
);

export default function VideoTemplateMedia() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });
  return (
    <VideoStage scene={currentScene} caption={CAPTIONS[currentScene]} accent={GOLD}>
      {currentScene === 0 && <SceneListen key="listen" />}
      {currentScene === 1 && <SceneBackground key="bg" />}
      {currentScene === 2 && <SceneConfirm key="confirm" />}
    </VideoStage>
  );
}
