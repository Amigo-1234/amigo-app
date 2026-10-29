import { useNavigate } from "react-router";
import { SearchX } from "lucide-react";
import { ScreenHeader } from "../shell/ScreenHeader";
import { Button } from "../ui/Button";
import { StateMessage } from "../ui/StateMessage";

export default function NotFoundScreen() {
  const navigate = useNavigate();
  return (
    <>
      <ScreenHeader title="Not found" />
      <StateMessage
        icon={<SearchX size={24} />}
        title="This page doesn't exist"
        body="The link may be broken or the page may have moved."
        action={<Button variant="secondary" onClick={() => navigate("/")}>Go Home</Button>}
      />
    </>
  );
}
