import { useRouter } from "expo-router";
import ChatRoomsList from "@/components/chat/ChatRoomsList";

export default function AdminChatScreen() {
  const router = useRouter();
  return <ChatRoomsList onSelectRoom={(id, name) => router.push({ pathname: "/(admin)/chat/[id]", params: { id, name } })} />;
}
