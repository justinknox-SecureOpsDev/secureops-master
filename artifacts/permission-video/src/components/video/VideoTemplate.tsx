import { useVideoPlayer } from '@/lib/video';
import { AnimatePresence, motion } from 'framer-motion';
import { PhoneBezel } from './Shared';
import { Scene1Disclosure } from './Scene1Disclosure';
import { Scene2Permission } from './Scene2Permission';
import { Scene3ClockIn } from './Scene3ClockIn';

const SCENE_DURATIONS = {
  disclosure: 8000,
  permission: 7000,
  clockIn: 8000,
};

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({
    durations: SCENE_DURATIONS,
  });

  return (
    <div className="w-full h-screen overflow-hidden relative bg-zinc-950 flex items-center justify-center font-display">
      {/* Background cinematic elements */}
      <div className="absolute inset-0 opacity-20">
        <motion.div 
          className="absolute top-1/4 left-1/4 w-[40vw] h-[40vw] bg-brand-gold/30 rounded-full blur-[100px]"
          animate={{
            x: currentScene === 2 ? '10vw' : currentScene === 1 ? '-5vw' : '0vw',
            y: currentScene === 2 ? '-10vw' : currentScene === 1 ? '5vw' : '0vw',
            scale: currentScene === 2 ? 1.5 : 1,
          }}
          transition={{ duration: 4, ease: "easeInOut" }}
        />
        <motion.div 
          className="absolute bottom-1/4 right-1/4 w-[30vw] h-[30vw] bg-blue-900/30 rounded-full blur-[80px]"
          animate={{
            scale: currentScene === 1 ? 1.2 : 1,
          }}
          transition={{ duration: 3, ease: "easeInOut" }}
        />
      </div>

      {/* Device Bezel */}
      <motion.div
        initial={{ y: 50, opacity: 0, scale: 0.95 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10"
      >
        <PhoneBezel>
          <AnimatePresence mode="popLayout">
            {currentScene === 0 && <Scene1Disclosure key="scene1" />}
            {currentScene === 1 && <Scene2Permission key="scene2" />}
            {currentScene === 2 && <Scene3ClockIn key="scene3" />}
          </AnimatePresence>
        </PhoneBezel>
      </motion.div>
    </div>
  );
}
