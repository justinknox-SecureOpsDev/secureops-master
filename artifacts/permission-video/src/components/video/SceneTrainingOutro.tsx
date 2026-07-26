import { motion } from 'framer-motion';
import { ShieldAlert, MessageSquare, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';

const FeatureSlide = ({ icon, title, active }: any) => (
  <motion.div 
    className="absolute inset-0 flex flex-col items-center justify-center"
    initial={{ opacity: 0, scale: 1.1 }}
    animate={{ opacity: active ? 1 : 0, scale: active ? 1 : 0.95 }}
    transition={{ duration: 0.6 }}
    style={{ pointerEvents: active ? 'auto' : 'none' }}
  >
    <div className="w-24 h-24 rounded-3xl bg-[#C9A84C]/10 border border-[#C9A84C]/30 flex items-center justify-center mb-6">
      {icon}
    </div>
    <h2 className="text-white text-2xl font-bold">{title}</h2>
  </motion.div>
);

export const SceneTrainingOutro = () => {
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    let timers = [
      setTimeout(() => setSlide(1), 1500),
      setTimeout(() => setSlide(2), 3000),
      setTimeout(() => setSlide(3), 4500),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div className="absolute inset-0 bg-[#0c0a08] overflow-hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(201,168,76,0.15),transparent_70%)]" />
      
      <FeatureSlide icon={<ShieldAlert className="w-12 h-12 text-[#dc2626]" />} title="SOS Emergency" active={slide === 0} />
      <FeatureSlide icon={<MessageSquare className="w-12 h-12 text-[#0284c7]" />} title="Team Chat" active={slide === 1} />
      <FeatureSlide icon={<FileText className="w-12 h-12 text-[#C9A84C]" />} title="Live Ops Plans" active={slide === 2} />
      
      <motion.div 
        className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: slide === 3 ? 1 : 0 }}
        transition={{ duration: 0.8 }}
        style={{ pointerEvents: slide === 3 ? 'auto' : 'none' }}
      >
        <motion.img
          src={`${import.meta.env.BASE_URL}images/emblem.png`}
          className="w-20 h-20 mb-6 opacity-80"
          initial={{ scale: 0.8 }}
          animate={{ scale: slide === 3 ? 1 : 0.8 }}
        />
        <h1 className="text-white text-3xl font-extrabold tracking-tight mb-3 leading-tight">
          You're ready.
        </h1>
        <p className="text-[#C9A84C] text-lg font-medium">Stay safe out there.</p>
      </motion.div>
    </motion.div>
  );
};
