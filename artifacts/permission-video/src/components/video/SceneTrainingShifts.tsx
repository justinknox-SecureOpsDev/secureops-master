import { motion } from 'framer-motion';
import { Pointer } from './Shared';
import { TopBar, BottomTab, ShiftCard } from './TrainingShared';
import { useEffect, useState } from 'react';

export const SceneTrainingShifts = () => {
  const [pointerState, setPointerState] = useState({ x: '60%', y: '80%', active: false, show: false });
  const [filter, setFilter] = useState('Upcoming');

  useEffect(() => {
    let timers = [
      setTimeout(() => setPointerState({ x: '60%', y: '16%', active: false, show: true }), 1000),
      setTimeout(() => setPointerState(p => ({ ...p, active: true })), 1800),
      setTimeout(() => {
        setFilter('Available');
        setPointerState(p => ({ ...p, active: false }));
      }, 2000),
      setTimeout(() => setPointerState(p => ({ ...p, show: false })), 2600)
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <motion.div className="absolute inset-0 bg-[#0c0a08] flex flex-col"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}
    >
      <TopBar title="My Shifts" />
      <div className="px-5 py-3 flex gap-2 overflow-x-auto relative z-10" style={{ scrollbarWidth: 'none' }}>
        {['Available', 'Upcoming', 'Active', 'Completed'].map(f => (
          <motion.div
            key={f}
            className="px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap"
            animate={{
              backgroundColor: filter === f ? '#C9A84C' : 'rgba(255,255,255,0.1)',
              color: filter === f ? '#1a1206' : 'rgba(255,255,255,0.6)',
            }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            {f}
          </motion.div>
        ))}
      </div>
      
      <div className="flex-1 overflow-hidden px-5 relative">
        <motion.div 
          className="absolute inset-x-5 top-0"
          animate={{ y: filter === 'Upcoming' ? 0 : 20, opacity: filter === 'Upcoming' ? 1 : 0 }}
          style={{ pointerEvents: filter === 'Upcoming' ? 'auto' : 'none' }}
        >
          <h2 className="text-white/40 text-xs font-bold uppercase tracking-wider mb-3 mt-2">Oct 24, 2023</h2>
          <ShiftCard 
            title="Night Patrol" site="Nexus Industrial Park" address="1200 Nexus Way"
            date="Friday, Oct 24" time="22:00 - 06:00" duration="8h"
            rate="$22.50/hr" total="~$180.00" licence="Level 2" status="Confirmed"
          />
        </motion.div>

        <motion.div 
          className="absolute inset-x-5 top-0"
          animate={{ y: filter === 'Available' ? 0 : 20, opacity: filter === 'Available' ? 1 : 0 }}
          style={{ pointerEvents: filter === 'Available' ? 'auto' : 'none' }}
        >
          <h2 className="text-white/40 text-xs font-bold uppercase tracking-wider mb-3 mt-2">Nearest to you</h2>
          <ShiftCard 
            title="Event Security" site="Downtown Arena" address="400 Main St"
            date="Saturday, Oct 25" time="18:00 - 02:00" duration="8h"
            rate="$25.00/hr" total="~$200.00" licence="Level 3"
          />
        </motion.div>
      </div>

      <Pointer {...pointerState} />
      <BottomTab active="work" />
    </motion.div>
  );
};
