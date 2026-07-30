import { motion } from 'framer-motion';
import { Shield, MapPin, Navigation } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Pointer, springSmooth, springSnappy } from './Shared';

export const Scene1Disclosure = () => {
  const [clickActive, setClickActive] = useState(false);
  const [pointerPos, setPointerPos] = useState({ x: '50%', y: '120%' });
  const [showPointer, setShowPointer] = useState(false);

  useEffect(() => {
    // Choreography
    const t1 = setTimeout(() => {
      setShowPointer(true);
      setPointerPos({ x: '50%', y: '85%' }); // Move to button
    }, 5500);

    const t2 = setTimeout(() => {
      setClickActive(true); // Click down
    }, 7000);

    const t3 = setTimeout(() => {
      setClickActive(false); // Release
    }, 7200);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return (
    <motion.div
      className="absolute inset-0 bg-[#0c0a08] flex flex-col pt-24 px-6 pb-12 z-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <motion.div 
        initial={{ scale: 0.8, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ delay: 0.3, ...springSnappy }}
        className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#C9A84C] to-[#91762e] flex items-center justify-center mb-8 mx-auto shadow-[0_0_30px_rgba(201,168,76,0.3)]"
      >
        <Navigation className="w-8 h-8 text-black fill-black" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, ...springSmooth }}
        className="text-2xl font-bold text-center text-white mb-6"
      >
        Location used for your shift
      </motion.h1>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7, ...springSmooth }}
        className="space-y-4 text-[15px] leading-relaxed text-zinc-300 flex-1"
      >
        <p>
          <strong className="text-white">SecureOps Command</strong> collects your precise location (GPS)
          when you clock in or out, scan a patrol checkpoint, send an emergency alert, and about once a
          minute while you are clocked in.
        </p>
        <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50 flex gap-4 mt-6">
          <Shield className="w-6 h-6 text-[#C9A84C] shrink-0" />
          <p className="text-sm">
            This is shared with your employer&apos;s dispatch and administrator team, so they can confirm
            you are on-site and respond if you need help. It is not sold or shared with advertisers.
          </p>
        </div>
        <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50 flex gap-4 mt-4">
          <MapPin className="w-6 h-6 text-[#C9A84C] shrink-0" />
          <p className="text-sm">
            Only while the app is open on your screen. SecureOps does not track your location in the
            background or when the app is closed.
          </p>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.2, ...springSnappy }}
        className="mt-auto relative"
      >
        <motion.div
          animate={{ scale: clickActive ? 0.95 : 1 }}
          className="w-full bg-[#C9A84C] text-black font-bold py-4 rounded-xl text-center text-lg"
        >
          I agree, continue
        </motion.div>
        {/* Play requires a real decline path, not just an acknowledgement. */}
        <div className="w-full py-3 text-center text-zinc-400 font-semibold text-base">
          Not now
        </div>
      </motion.div>

      <Pointer x={pointerPos.x} y={pointerPos.y} active={clickActive} show={showPointer} />
    </motion.div>
  );
};