import { useRouter } from "expo-router";
import ChatRoomsList from "@/components/chat/ChatRoomsList";

export default function EmployeeChatScreen() {
  const router = useRouter();
  return <ChatRoomsList onSelectRoom={(id, name) => router.push({ pathname: "/(employee)/chat/[id]", params: { id, name } })} />;
}
