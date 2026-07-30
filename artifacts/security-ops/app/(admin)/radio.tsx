import RadioScreen from "@/components/radio/RadioScreen";
import { FeatureGate } from "@/components/FeatureGate";

export default function AdminRadio() {
  return (
    <FeatureGate feature="radio">
      {/* The admin tab layout shows a native header (headerShown: true), which
          already reserves the status-bar / notch space — so the screen must not
          reserve it again or we get a dead gap under the header. */}
      <RadioScreen topInset={false} />
    </FeatureGate>
  );
}
