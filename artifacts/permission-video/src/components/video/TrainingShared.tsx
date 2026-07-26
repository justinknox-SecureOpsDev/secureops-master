import { motion } from 'framer-motion';
import { Briefcase, Clock, User, ShieldCheck, MapPin, ChevronRight } from 'lucide-react';
import { StatusBar } from './RadioShared';

export const GOLD = '#C9A84C';

export const TopBar = ({ title, subtitle }: { title: string, subtitle?: string }) => (
  <div className="pt-3 pb-3 px-5 bg-[#0c0a08] border-b border-white/10 shrink-0 relative z-20">
    <StatusBar />
    <div className="mt-4">
      <h1 className="text-white text-2xl font-bold">{title}</h1>
      {subtitle && <p className="text-white/50 text-sm">{subtitle}</p>}
    </div>
  </div>
);

export const BottomTab = ({ active }: { active: string }) => (
  <div className="absolute bottom-0 left-0 right-0 h-[88px] bg-[#0c0a08]/95 backdrop-blur-xl border-t border-white/10 flex items-start justify-around px-2 pt-3 z-40">
    <Tab icon={<Briefcase className="w-6 h-6" />} label="My Work" active={active === 'work'} />
    <Tab icon={<Clock className="w-6 h-6" />} label="Clock In/Out" active={active === 'clock'} />
    <Tab icon={<User className="w-6 h-6" />} label="Profile" active={active === 'profile'} />
  </div>
);

const Tab = ({ icon, label, active }: any) => (
  <div className="flex flex-col items-center gap-1 w-20">
    <div className={`${active ? 'text-[#C9A84C]' : 'text-white/40'}`}>
      {icon}
    </div>
    <span className={`text-[10px] font-semibold ${active ? 'text-[#C9A84C]' : 'text-white/40'}`}>{label}</span>
  </div>
);

export const ShiftCard = ({ 
  title, site, address, date, time, duration, rate, total, licence, status,
  actionIcon, actionLabel
}: any) => {
  return (
    <div className="bg-[#1a1612] border border-white/5 rounded-2xl overflow-hidden shadow-xl mb-4">
      {status && (
        <div className={`px-4 py-1.5 text-xs font-bold flex items-center justify-between
          ${status === 'Confirmed' ? 'bg-[#16a34a]/20 text-[#4ade80]' : 
            status === 'Awaiting acceptance' ? 'bg-[#C9A84C]/20 text-[#fde047]' : 
            'bg-white/10 text-white/70'}`}
        >
          <span>{status}</span>
        </div>
      )}
      <div className="p-4">
        <div className="flex justify-between items-start mb-2">
          <div>
            <h3 className="text-white font-bold text-lg">{title}</h3>
            <div className="flex items-center gap-1.5 text-white/50 text-xs mt-1">
              <ShieldCheck className="w-3.5 h-3.5" style={{ color: GOLD }} />
              <span>{site}</span>
            </div>
            <div className="flex items-center gap-1.5 text-white/40 text-xs mt-0.5">
              <MapPin className="w-3.5 h-3.5" />
              <span className="truncate max-w-[200px]">{address}</span>
            </div>
          </div>
          <div className="bg-white/10 px-2 py-1 rounded text-white/80 text-[10px] font-bold">
            {licence}
          </div>
        </div>
        
        <div className="h-px bg-white/5 my-3" />
        
        <div className="flex justify-between items-end">
          <div>
            <p className="text-white font-semibold text-sm">{date}</p>
            <p className="text-white/60 text-xs">{time} • <span className="text-white/40">{duration}</span></p>
          </div>
          <div className="text-right">
            <p className="text-white font-bold">{total}</p>
            <p className="text-white/40 text-[10px]">{rate}</p>
          </div>
        </div>

        {actionLabel && (
          <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-[#C9A84C] font-semibold text-sm">
            <div className="flex items-center gap-2">
              {actionIcon}
              <span>{actionLabel}</span>
            </div>
            <ChevronRight className="w-4 h-4" />
          </div>
        )}
      </div>
    </div>
  )
}
