import { Sidebar } from '~/components/mira/sidebar';
import { TopHeader } from '~/components/mira/top-header';

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="editorial-layout">
      <Sidebar />
      <div>
        <TopHeader />
        <div className="main-stage">{children}</div>
      </div>
    </div>
  );
}
