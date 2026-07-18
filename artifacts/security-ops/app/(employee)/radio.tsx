import RadioScreen from "@/components/radio/RadioScreen";
import { FeatureGate } from "@/components/FeatureGate";

export default function EmployeeRadio() {
  return (
    <FeatureGate feature="radio">
      <RadioScreen />
    </FeatureGate>
  );
}
