export default function StatusBadge(props: { status: string }) {
  const statusClass = () => {
    switch (props.status) {
      case "complete":
        return "success";
      case "failed":
      case "error":
        return "failed";
      case "pending":
      case "running":
        return "pending";
      case "partial":
        return "partial";
      case "skipped":
      case "expired":
        return "muted";
      case "needs_2fa":
        return "warning";
      default:
        return "";
    }
  };
  const cls = () => statusClass() ? `badge badge-${statusClass()}` : "badge";
  return <span class={cls()}>{props.status}</span>;
}
