import { motion, AnimatePresence } from 'framer-motion';
import { Pointer, springSmooth } from './Shared';
import { TopBar, BottomTab, ShiftCard } from './TrainingShared';
import { Bookmark, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export const SceneTrainingClaim = () => {
  const [pointer, setPointer] = useState({ x: '50%', y: '80%', active: false, show: false });
  const [modalOpen, setModalOpen] = useState(false);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    let timers = [
      setTimeout(() => setPointer({ x: '50%', y: '56%', active: false, show: true }), 500),
      setTimeout(() => setPointer(p => ({ ...p, active: true })), 1500),
      setTimeout(() => {
        setPointer(p => ({ ...p, active: false }));
        setModalOpen(true);
      }, 1700),
      setTimeout(() => setPointer({ x: '50%', y: '70%', active: false, show: true }), 2500),
      setTimeout(() => setPointer(p => ({ ...p, active: true })), 3500),
      setTimeout(() => {
        setPointer(p => ({ ...p, active: false, show: false }));
        setRequested(true);
      }, 3700),
      setTimeout(() => setModalOpen(false), 6000)
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div className="absolute inset-0 bg-[#0c0a08] flex flex-col"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}
    >
      <TopBar title="My Shifts" />
      <div className="px-5 py-3 flex gap-2 overflow-x-auto relative z-10" style={{ scrollbarWidth: 'none' }}>
        {['Available', 'Upcoming', 'Active'].map(f => (
          <div key={f} className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap
            ${f === 'Available' ? 'bg-[#C9A84C] text-[#1a1206]' : 'bg-white/10 text-white/60'}`}
          >
            {f}
          </div>
        ))}
      </div>
      
      <div className="flex-1 px-5 relative pt-2">
        <h2 className="text-white/40 text-xs font-bold uppercase tracking-wider mb-3">Nearest to you</h2>
        <ShiftCard 
          title="Event Security" site="Downtown Arena" address="400 Main St"
          date="Saturday, Oct 25" time="18:00 - 02:00" duration="8h"
          rate="$25.00/hr" total="~$200.00" licence="Level 3"
          actionIcon={<Bookmark className="w-4 h-4" />} actionLabel="Request Slot"
        />
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
              {!requested ? (
                <>
                  <h3 className="text-white text-xl font-bold mb-2">Request this shift?</h3>
                  <p className="text-white/60 text-sm mb-6">This request will be sent to your dispatcher for approval. You'll be notified once confirmed.</p>
                  <div className="bg-[#C9A84C] text-[#1a1206] py-3.5 rounded-xl font-bold text-center text-sm">
                    Send Request
                  </div>
                  <div className="mt-3 py-3.5 text-center text-white/60 font-bold text-sm">
                    Cancel
                  </div>
                </>
              ) : (
                <motion.div 
                  className="flex flex-col items-center py-6"
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                >
                  <div className="w-16 h-16 bg-[#16a34a]/20 rounded-full flex items-center justify-center mb-4 border border-[#16a34a]/30">
                    <CheckCircle2 className="w-8 h-8 text-[#4ade80]" />
                  </div>
                  <h3 className="text-white text-xl font-bold mb-1">Request Sent</h3>
                  <p className="text-white/50 text-sm text-center">Awaiting dispatcher approval.</p>
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
