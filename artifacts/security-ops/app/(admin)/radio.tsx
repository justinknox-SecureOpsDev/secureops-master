import RadioScreen from "@/components/radio/RadioScreen";
import { FeatureGate } from "@/components/FeatureGate";

export default function AdminRadio() {
  return (
    <FeatureGate feature="radio">
      <RadioScreen />
    </FeatureGate>
  );
}
