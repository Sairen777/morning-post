import type { JSX } from "solid-js";

export interface ServiceIconProps {
  connectorId: string;
  size?: number | string;
  title?: string;
}

function ServiceArtwork(props: { connectorId: string }): JSX.Element {
  const connector = props.connectorId.toLowerCase();

  if (connector === "telegram") {
    return <path d="M21.2 4.2 3.7 10.95c-.92.36-.91.86-.17 1.08l4.48 1.4 1.72 5.32c.2.56.1.78.68.78.45 0 .65-.2.9-.44l2.18-2.12 4.53 3.34c.84.46 1.45.22 1.66-.78l2.98-14.05c.31-1.24-.47-1.8-1.46-1.28ZM8.7 13.1l9.95-6.28c.47-.29.91-.13.55.18l-8.08 7.3-.32 3.45-.84-3.06-1.26-1.59Z" />;
  }

  if (connector === "substack") {
    return <>
      <path d="M4 5.25h16M4 8.7h16M5.5 12.1v6.65L12 15l6.5 3.75V12.1" />
    </>;
  }

  if (connector === "x" || connector === "twitter") {
    return <path d="m4.2 4 6.08 7.1L4 20h1.38l5.52-6.1 5.23 6.1H20l-6.42-7.5L19.6 4h-1.38l-5.02 5.54L8.35 4H4.2Zm1.87 1h1.84l8.15 14h-1.84L6.07 5Z" />;
  }

  if (connector === "youtube") {
    return <>
      <rect x="3" y="6" width="18" height="12" rx="3" />
      <path d="m10 9 5 3-5 3V9Z" fill="currentColor" stroke="none" />
    </>;
  }

  if (connector === "reddit") {
    return <>
      <circle cx="12" cy="13" r="7" />
      <path d="M8.5 14.25c.9 1.15 2.07 1.72 3.5 1.72s2.6-.57 3.5-1.72M9 11.25h.01M15 11.25h.01M12 6V3.5l3 .65" />
      <circle cx="17.2" cy="4.35" r="1.2" />
    </>;
  }

  if (connector === "rss" || connector === "feed") {
    return <>
      <circle cx="5.2" cy="18.8" r="1.5" fill="currentColor" stroke="none" />
      <path d="M4.25 12.5a7.25 7.25 0 0 1 7.25 7.25M4.25 7a12.75 12.75 0 0 1 12.75 12.75" />
    </>;
  }

  return <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 10.5v5M12 7.5h.01" />
  </>;
}

export default function ServiceIcon(props: ServiceIconProps) {
  const size = props.size ?? 20;
  const accessible = props.title !== undefined;

  return (
    <svg
      class="service-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={accessible ? "img" : "presentation"}
      aria-hidden={accessible ? undefined : "true"}
      aria-label={accessible ? props.title : undefined}
    >
      {accessible ? <title>{props.title}</title> : null}
      <ServiceArtwork connectorId={props.connectorId} />
    </svg>
  );
}

export { ServiceIcon };
