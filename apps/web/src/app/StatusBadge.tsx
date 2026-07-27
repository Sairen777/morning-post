export default function StatusBadge(props: { status: string; label?: string }) {
  const statusClass = () => {
    switch (props.status) {
      case "complete":
        return "success";
      case "failed":
      case "error":
        return "failed";
      case "pending":
      case "running":
      case "awaiting_login":
        return "pending";
      case "partial":
        return "partial";
      case "skipped":
      case "expired":
        return "muted";
      case "needs_2fa":
      case "awaiting_chat_unlock":
        return "warning";
      default:
        return "";
    }
  };
  const cls = () => statusClass() ? `badge badge-${statusClass()}` : "badge";
  return <span class={cls()}>{props.label ?? props.status}</span>;
}
