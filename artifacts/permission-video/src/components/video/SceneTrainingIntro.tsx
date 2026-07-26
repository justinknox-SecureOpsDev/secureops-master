import { motion } from 'framer-motion';
import { springSmooth, springBouncy } from './Shared';

export const SceneTrainingIntro = () => {
  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center bg-[#0c0a08]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(201,168,76,0.1),transparent_60%)]" />
      <motion.img
        src={`${import.meta.env.BASE_URL}images/emblem.png`}
        className="w-32 h-32 mb-6 drop-shadow-2xl relative z-10"
        initial={{ scale: 0.8, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ delay: 0.3, ...springBouncy }}
      />
      <motion.h1
        className="text-white text-3xl font-extrabold tracking-tight mb-2 relative z-10"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, ...springSmooth }}
      >
        SecureOps Command
      </motion.h1>
      <motion.p
        className="text-[#C9A84C] text-sm font-semibold tracking-widest uppercase relative z-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.9 }}
      >
        Officer Quick-Start Guide
      </motion.p>
    </motion.div>
  );
}
