import { motion, AnimatePresence } from 'framer-motion';
import { Pointer, springSmooth } from './Shared';
import { TopBar, BottomTab } from './TrainingShared';
import { CheckCircle2, ChevronRight, FileSignature } from 'lucide-react';
import { useEffect, useState } from 'react';

export const SceneTrainingConfirm = () => {
  const [pointer, setPointer] = useState({ x: '50%', y: '80%', active: false, show: false });
  const [modalOpen, setModalOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let timers = [
      setTimeout(() => setPointer({ x: '50%', y: '32%', active: false, show: true }), 500),
      setTimeout(() => setPointer(p => ({ ...p, active: true })), 1500),
      setTimeout(() => {
        setPointer(p => ({ ...p, active: false }));
        setModalOpen(true);
      }, 1700),
      setTimeout(() => setPointer({ x: '50%', y: '78%', active: false, show: true }), 2500),
      setTimeout(() => setPointer(p => ({ ...p, active: true })), 3500),
      setTimeout(() => {
        setPointer(p => ({ ...p, active: false, show: false }));
        setSubmitted(true);
      }, 3700),
      setTimeout(() => setModalOpen(false), 6500)
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div className="absolute inset-0 bg-[#0c0a08] flex flex-col"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}
    >
      <TopBar title="My Work" />
      
      <div className="flex-1 px-5 pt-6 relative">
        <h2 className="text-white/40 text-xs font-bold uppercase tracking-wider mb-3">Action Required</h2>
        
        <div className="bg-[#C9A84C]/10 border border-[#C9A84C]/30 rounded-2xl p-4 flex items-center justify-between mb-8 shadow-[0_0_20px_rgba(201,168,76,0.05)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#C9A84C]/20 flex items-center justify-center">
              <FileSignature className="w-5 h-5 text-[#C9A84C]" />
            </div>
            <div>
              <p className="text-white font-bold text-sm">Confirm your last shift</p>
              <p className="text-white/50 text-xs mt-0.5">Nexus Industrial Park • 8h</p>
            </div>
          </div>
          <ChevronRight className="w-5 h-5 text-[#C9A84C]" />
        </div>

        <h2 className="text-white/40 text-xs font-bold uppercase tracking-wider mb-3">Recent Time Entries</h2>
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex justify-between items-center opacity-50">
           <div>
              <p className="text-white font-bold text-sm">Downtown Arena</p>
              <p className="text-white/50 text-xs mt-0.5">Oct 20 • 6h 30m</p>
           </div>
           <div className="text-right">
              <p className="text-[#4ade80] text-xs font-bold">Approved</p>
           </div>
        </div>
      </div>

      <AnimatePresence>
        {modalOpen && (
          <motion.div 
            className="absolute inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          >
            <motion.div 
              className="bg-[#1a1612] rounded-t-3xl p-6 border-t border-white/10 pb-12"
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={springSmooth}
            >
              {!submitted ? (
                <>
                  <h3 className="text-white text-xl font-bold mb-4">Review & Confirm</h3>
                  <div className="bg-white/5 rounded-xl p-4 mb-4">
                    <div className="flex justify-between mb-3 pb-3 border-b border-white/10">
                      <div className="text-white/50 text-sm">Clock In</div>
                      <div className="text-white font-semibold text-sm">22:01</div>
                    </div>
                    <div className="flex justify-between mb-3 pb-3 border-b border-white/10">
                      <div className="text-white/50 text-sm">Clock Out</div>
                      <div className="text-white font-semibold text-sm">06:05</div>
                    </div>
                    <div className="flex justify-between items-center">
                      <div className="text-white/50 text-sm">Total Hours</div>
                      <div className="text-[#C9A84C] font-bold text-lg">8h 4m</div>
                    </div>
                  </div>
                  
                  <div className="flex justify-between items-center mb-6">
                    <p className="text-white/40 text-xs">Need to adjust your time?</p>
                    <p className="text-[#0284c7] font-semibold text-sm">Edit times</p>
                  </div>

                  <div className="bg-[#16a34a] text-white py-3.5 rounded-xl font-bold text-center text-sm flex items-center justify-center gap-2">
                    <CheckCircle2 className="w-5 h-5" />
                    Submit for Approval
                  </div>
                </>
              ) : (
                <motion.div 
                  className="flex flex-col items-center py-8"
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                >
                  <div className="w-16 h-16 bg-[#16a34a]/20 rounded-full flex items-center justify-center mb-4 border border-[#16a34a]/30">
                    <CheckCircle2 className="w-8 h-8 text-[#4ade80]" />
                  </div>
                  <h3 className="text-white text-xl font-bold mb-1">Time Submitted</h3>
                  <p className="text-white/50 text-sm text-center">Your entry has been sent to admin.</p>
                </motion.div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <Pointer {...pointer} />
      <BottomTab active="work" />
    </motion.div>
  );
};
