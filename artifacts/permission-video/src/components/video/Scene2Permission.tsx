import { motion } from 'framer-motion';
import { Navigation, Shield, MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Pointer, springSmooth, springSnappy } from './Shared';

export const Scene2Permission = () => {
  const [clickActive, setClickActive] = useState(false);
  const [pointerPos, setPointerPos] = useState({ x: '50%', y: '120%' });
  const [showPointer, setShowPointer] = useState(false);

  useEffect(() => {
    // Choreography
    const t1 = setTimeout(() => {
      setShowPointer(true);
      setPointerPos({ x: '50%', y: '65%' }); // Move to "While using the app"
    }, 4000);

    const t2 = setTimeout(() => {
      setClickActive(true); // Click down
    }, 5500);

    const t3 = setTimeout(() => {
      setClickActive(false); // Release
    }, 5700);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 bg-[#0c0a08] flex flex-col z-20"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Background (Static Scene 1 Content) */}
      <div className="absolute inset-0 flex flex-col pt-24 px-6 pb-12 opacity-50 blur-[2px]">
        <div className="w-16 h-16 rounded-2xl bg-[#C9A84C] flex items-center justify-center mb-8 mx-auto">
          <Navigation className="w-8 h-8 text-black fill-black" />
        </div>
        <h1 className="text-2xl font-bold text-center text-white mb-6">
          Location used for your shift
        </h1>
        <div className="space-y-4 text-[15px] leading-relaxed text-zinc-300 flex-1">
          <p><strong className="text-white">SecureOps Command</strong> collects your precise location (GPS) when you clock in or out, scan a patrol checkpoint, send an emergency alert, and about once a minute while you are clocked in.</p>
          <div className="p-4 rounded-xl bg-zinc-900/50 border border-zinc-800/50 flex gap-4 mt-6">
            <Shield className="w-6 h-6 text-[#C9A84C] shrink-0" />
            <p className="text-sm">This is shared with your employer&apos;s dispatch and administrator team, so they can confirm you are on-site and respond if you need help.</p>
          </div>
        </div>
        <div className="mt-auto">
          <div className="w-full bg-[#C9A84C] text-black font-bold py-4 rounded-xl text-center text-lg">
            I agree, continue
          </div>
        </div>
      </div>

      {/* Dimming Overlay */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/60"
      />

      {/* Android Permission Dialog */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: -10 }}
        transition={{ delay: 0.2, ...springSnappy }}
        className="absolute bottom-6 left-4 right-4 bg-[#2d2d2d] rounded-3xl p-6 shadow-2xl font-body"
      >
        <div className="flex flex-col items-center mb-6">
          {/* Mock app icon */}
          <div className="w-12 h-12 rounded-full overflow-hidden mb-4 bg-black border border-zinc-700 flex justify-center items-center">
             <img src={`${import.meta.env.BASE_URL}images/feature-graphic.png`} alt="App Icon" className="w-full h-full object-cover" />
          </div>
          <h2 className="text-lg font-medium text-center text-zinc-100">
            Allow <span className="font-bold">SecureOps Command</span> to access this device's location?
          </h2>
        </div>

        {/* Android 12+ Precise/Approximate map mock */}
        <div className="w-full h-24 bg-zinc-800 rounded-xl mb-4 relative overflow-hidden border border-zinc-700 flex justify-center items-center">
          <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1524661135-423995f22d0b?auto=format&fit=crop&q=80&w=800')] opacity-30 bg-cover bg-center mix-blend-luminosity grayscale" />
          <div className="absolute top-2 right-2 bg-zinc-700/80 backdrop-blur rounded px-3 py-1 text-xs text-white">Precise</div>
          <MapPin className="w-8 h-8 text-blue-400 fill-blue-400/20 relative z-10" />
        </div>

        <div className="space-y-2">
          <motion.div 
            animate={{ backgroundColor: clickActive ? '#404040' : '#2d2d2d' }}
            className="w-full py-4 rounded-xl text-center text-[#8ab4f8] font-medium border border-zinc-700/50"
          >
            While using the app
          </motion.div>
          <div className="w-full py-4 rounded-xl text-center text-[#8ab4f8] font-medium">
            Only this time
          </div>
          <div className="w-full py-4 rounded-xl text-center text-[#8ab4f8] font-medium">
            Don't allow
          </div>
        </div>
      </motion.div>

      <Pointer x={pointerPos.x} y={pointerPos.y} active={clickActive} show={showPointer} />
    </motion.div>
  );
};