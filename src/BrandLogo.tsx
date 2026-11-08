type BrandLogoProps = {
  className?: string;
};

export default function BrandLogo({ className = "" }: BrandLogoProps) {
  return <img className={className} src="/market-agent-mark.svg?v=logo2b" alt="" aria-hidden="true" />;
}
