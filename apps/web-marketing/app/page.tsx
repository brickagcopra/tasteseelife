import { FaqSection } from '@/components/faq';
import { Family } from '@/components/family';
import { Footer } from '@/components/footer';
import { Hero } from '@/components/hero';
import { HowItWorks } from '@/components/how-it-works';
import { MeetChefs } from '@/components/meet-chefs';
import { Mission } from '@/components/mission';
import { Nav } from '@/components/nav';
import { Pricing } from '@/components/pricing';
import { Quiz } from '@/components/quiz';
import { SampleWeek } from '@/components/sample-week';
import { Services } from '@/components/services';

export default function MarketingHomePage(): React.JSX.Element {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Services />
        <SampleWeek />
        <MeetChefs />
        <Family />
        <Mission />
        <Pricing />
        <Quiz />
        <FaqSection />
      </main>
      <Footer />
    </>
  );
}
