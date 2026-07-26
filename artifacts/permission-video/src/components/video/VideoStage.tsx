import { AnimatePresence, motion } from 'framer-motion';
import { PhoneBezel } from './Shared';
import { GOLD } from './RadioShared';

export interface Caption {
  step: string;
  title: string;
  body: string;
  pill?: string;
}

export const VideoStage = ({
  scene,
  caption,
  accent = GOLD,
  children,
}: {
  scene: number;
  caption: Caption;
  accent?: string;
  children: React.ReactNode;
}) => (
  <div
    className="w-full h-screen overflow-hidden relative flex items-center justify-center gap-[5vw] px-[6vw] font-display"
    style={{ backgroundColor: '#08070a' }}
  >
    {/* Cinematic background orbs */}
    <div className="absolute inset-0 opacity-25">
      <motion.div
        className="absolute top-1/4 left-[15%] w-[40vw] h-[40vw] rounded-full blur-[120px]"
        style={{ backgroundColor: `${accent}30` }}
        animate={{ scale: [1, 1.15, 1] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute bottom-1/4 right-[12%] w-[32vw] h-[32vw] rounded-full blur-[100px] bg-blue-900/40" />
    </div>

    {/* Phone */}
    <motion.div
      initial={{ y: 40, opacity: 0, scale: 0.96 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      className="relative z-10 shrink-0"
    >
      <PhoneBezel>
        <AnimatePresence mode="popLayout">{children}</AnimatePresence>
      </PhoneBezel>
    </motion.div>

    {/* Caption panel */}
    <div className="relative z-10 w-[34vw] max-w-[520px]">
      <AnimatePresence mode="wait">
        <motion.div
          key={scene}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex flex-wrap items-center gap-2 mb-5">
            <span
              className="text-sm font-bold px-3 py-1 rounded-full"
              style={{ backgroundColor: accent, color: '#1a1206' }}
            >
              {caption.step}
            </span>
            {caption.pill && (
              <span className="text-xs font-mono font-semibold px-3 py-1 rounded-full text-white/70 border border-white/15">
                {caption.pill}
              </span>
            )}
          </div>
          <h2 className="text-white text-4xl font-extrabold leading-[1.1] mb-4">{caption.title}</h2>
          <p className="text-white/60 text-lg leading-relaxed">{caption.body}</p>
        </motion.div>
      </AnimatePresence>
    </div>
  </div>
);
