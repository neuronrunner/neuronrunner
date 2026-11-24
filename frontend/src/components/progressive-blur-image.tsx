"use client";

import { useEffect, useState } from "react";

interface ProgressiveBlurImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src?: string;
  blurDataUrl?: string;
  alt: string;
  containerClassName?: string;
}

const ProgressiveBlurImage = ({
  src,
  blurDataUrl,
  alt,
  containerClassName = "",
  className = "",
  ...imageProps
}: ProgressiveBlurImageProps) => {
  const [isHighResLoaded, setIsHighResLoaded] = useState(false);

  useEffect(() => {
    setIsHighResLoaded(false);

    if (!src) {
      return;
    }

    const image = new window.Image();
    image.src = src;
    image.onload = () => setIsHighResLoaded(true);
    image.onerror = () => setIsHighResLoaded(true);
  }, [src]);

  const displaySrc = isHighResLoaded ? src : (blurDataUrl || src);

  return (
    <div className={`relative overflow-hidden ${containerClassName}`}>
      <img
        src={displaySrc}
        alt={alt}
        className={`transition-all duration-200 ${
          isHighResLoaded ? "blur-0 scale-100" : "blur-md scale-105"
        } ${className}`}
        {...imageProps}
      />
    </div>
  );
};

export default ProgressiveBlurImage;
