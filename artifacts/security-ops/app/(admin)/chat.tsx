import { useRouter } from "expo-router";
import ChatRoomsList from "@/components/chat/ChatRoomsList";
import { FeatureGate } from "@/components/FeatureGate";

export default function AdminChatScreen() {
  const router = useRouter();
  return (
    <FeatureGate feature="chat">
      {/* The admin tab layout shows a native header (headerShown: true), which
          already reserves the status-bar / notch space — so the list must not
          reserve it again or we get a dead gap under the header. */}
      <ChatRoomsList topInset={false} onSelectRoom={(id, name) => router.push({ pathname: "/(admin)/chat/[id]", params: { id, name } })} />
    </FeatureGate>
  );
}
