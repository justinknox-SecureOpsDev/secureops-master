import VideoTemplate from '@/components/video/VideoTemplate';
import VideoTemplateMedia from '@/components/video/VideoTemplateMedia';
import VideoTemplateMic from '@/components/video/VideoTemplateMic';
import VideoTemplateTraining from '@/components/video/VideoTemplateTraining';

export default function App() {
  const v =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('v')
      : null;

  if (v === 'media') return <VideoTemplateMedia />;
  if (v === 'mic') return <VideoTemplateMic />;
  if (v === 'training') return <VideoTemplateTraining />;
  return <VideoTemplate />;
}
