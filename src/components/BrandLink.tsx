import Image from "next/image";
import Link from "next/link";
import type { MouseEventHandler } from "react";

type BrandLinkProps = {
  className?: string;
  label?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  priority?: boolean;
};

export function BrandLink({ className = "", label = "Bubble Wash", onClick, priority = false }: BrandLinkProps) {
  return (
    <Link className={["brand", className].filter(Boolean).join(" ")} href="/" aria-label="Bubble Wash home" onClick={onClick}>
      <span className="brandArtwork" aria-hidden="true">
        <Image className="brandMark" src="/bubble-wash-icon.jpg" alt="" width={58} height={58} priority={priority} />
      </span>
      <span>{label}</span>
    </Link>
  );
}
