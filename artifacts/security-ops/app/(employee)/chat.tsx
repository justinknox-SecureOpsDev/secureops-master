import { useRouter } from "expo-router";
import ChatRoomsList from "@/components/chat/ChatRoomsList";
import { FeatureGate } from "@/components/FeatureGate";

export default function EmployeeChatScreen() {
  const router = useRouter();
  return (
    <FeatureGate feature="chat">
      <ChatRoomsList onSelectRoom={(id, name) => router.push({ pathname: "/(employee)/chat/[id]", params: { id, name } })} />
    </FeatureGate>
  );
}
