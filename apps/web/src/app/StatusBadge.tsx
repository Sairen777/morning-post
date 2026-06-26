import type { DigestStatus } from "../api/types";

export default function StatusBadge(props: { status: DigestStatus }) {
  const statusClass = () => props.status === "complete" ? "success" : props.status;
  const cls = () => `badge badge-${statusClass()}`;
  return <span class={cls()}>{props.status}</span>;
}
