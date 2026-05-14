import { useLocalSearchParams } from "expo-router";
import ChatRoomScreen from "@/components/chat/ChatRoomScreen";

export default function AdminChatRoom() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  return <ChatRoomScreen roomId={id} roomName={name || "Chat"} />;
}
