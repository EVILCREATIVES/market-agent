type BrandLogoProps = {
  className?: string;
};

export default function BrandLogo({ className = "" }: BrandLogoProps) {
  return <img className={className} src="/market-agent-mark.svg" alt="" aria-hidden="true" />;
}
