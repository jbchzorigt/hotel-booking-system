"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, BedDouble, Building2, Hotel, Star } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * HotelCard — the "Petra" reference design.
 *
 * Image slider is a CSS scroll-snap track (native touch swipe, mouse-wheel
 * horizontal scroll, clickable dots) — no carousel dependency. When no
 * image URLs are supplied it renders gradient placeholder slides so the
 * swipe/dots behaviour is identical either way.
 */
export interface HotelCardProps {
  title: string;
  /** Dot-separated meta row, e.g. ["May 1 - 6", "Family friendly"]. */
  meta: string[];
  description: string;
  /** Formatted price, e.g. "₮139,000". */
  price: string;
  period?: string;
  rating: number;
  /** Glass pills over the image's top-left. */
  tags: string[];
  images?: string[];
  topRated?: boolean;
  href: string;
  ctaLabel?: string;
  disabled?: boolean;
}

const PLACEHOLDER_SLIDES = [
  { gradient: "from-sky-300 via-blue-400 to-blue-600", Icon: BedDouble },
  { gradient: "from-indigo-300 via-blue-400 to-sky-500", Icon: Building2 },
  { gradient: "from-cyan-300 via-sky-400 to-indigo-500", Icon: Hotel },
];

export default function HotelCard({
  title,
  meta,
  description,
  price,
  period = "night",
  rating,
  tags,
  images = [],
  topRated = false,
  href,
  ctaLabel = "Book Now",
  disabled = false,
}: HotelCardProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);

  const slideCount = images.length > 0 ? images.length : PLACEHOLDER_SLIDES.length;

  const handleScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    setActiveSlide(
      Math.min(
        slideCount - 1,
        Math.round(track.scrollLeft / track.clientWidth)
      )
    );
  }, [slideCount]);

  const scrollTo = (index: number) => {
    const track = trackRef.current;
    track?.scrollTo({ left: index * track.clientWidth, behavior: "smooth" });
  };

  return (
    <article
      className={cn(
        "flex flex-col rounded-3xl bg-white p-2 shadow-md shadow-slate-900/5 transition-shadow duration-300 hover:shadow-xl hover:shadow-slate-900/10",
        disabled && "opacity-60"
      )}
    >
      {/* ---------------- Image slider ---------------- */}
      <div className="relative overflow-hidden rounded-2xl">
        <div
          ref={trackRef}
          onScroll={handleScroll}
          className="no-scrollbar flex aspect-[4/3] snap-x snap-mandatory overflow-x-auto scroll-smooth"
        >
          {images.length > 0
            ? images.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt={`${title} — photo ${i + 1}`}
                  className="h-full w-full shrink-0 snap-center object-cover"
                  loading="lazy"
                />
              ))
            : PLACEHOLDER_SLIDES.map(({ gradient, Icon }, i) => (
                <div
                  key={i}
                  aria-label={`${title} — photo ${i + 1}`}
                  className={cn(
                    "flex h-full w-full shrink-0 snap-center items-center justify-center bg-gradient-to-br",
                    gradient
                  )}
                >
                  <Icon className="h-14 w-14 text-white/60" strokeWidth={1} />
                </div>
              ))}
        </div>

        {/* Top-left: glassmorphism tag pills */}
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-white/10 bg-white/20 px-3.5 py-1.5 text-sm font-medium text-white backdrop-blur-md"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Top-right: rating */}
        <span className="pointer-events-none absolute right-4 top-4 flex items-center gap-1.5 text-white drop-shadow">
          <Star className="h-4 w-4 fill-white" />
          <span className="text-sm font-semibold">{rating.toFixed(1)}</span>
        </span>

        {/* Pagination dots */}
        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
          {Array.from({ length: slideCount }).map((_, i) => (
            <button
              key={i}
              onClick={() => scrollTo(i)}
              aria-label={`Go to photo ${i + 1}`}
              className={cn(
                "h-2 w-2 rounded-full transition-colors",
                i === activeSlide ? "bg-white" : "bg-white/40"
              )}
            />
          ))}
        </div>
      </div>

      {/* ---------------- Content ---------------- */}
      <div className="flex flex-1 flex-col px-4 pb-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-2xl font-medium tracking-tight text-slate-900">
            {title}
          </h3>
          {topRated && (
            <span className="mt-1 shrink-0 rounded-full border border-slate-300 px-3.5 py-1 text-sm text-slate-700">
              Top rated
            </span>
          )}
        </div>

        <p className="mt-2 text-sm text-slate-400">
          {meta.map((part, i) => (
            <span key={i}>
              {i > 0 && <span className="mx-1.5">•</span>}
              {part}
            </span>
          ))}
        </p>

        <p className="mt-3 line-clamp-2 flex-1 text-sm leading-relaxed text-slate-400">
          {description}
        </p>

        {/* ---------------- Footer / action row ---------------- */}
        <div className="mt-5 flex items-center justify-between gap-3">
          <p className="text-2xl tracking-tight text-slate-900">
            <span className="font-semibold">{price}</span>
            <span className="font-normal text-slate-500"> / {period}</span>
          </p>

          <Link
            href={href}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? -1 : undefined}
            className={cn(
              "group flex shrink-0 items-center gap-2.5 rounded-full bg-slate-900 py-1.5 pl-5 pr-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-800",
              disabled && "pointer-events-none"
            )}
          >
            {ctaLabel}
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-900 transition-transform duration-200 group-hover:rotate-45">
              <ArrowUpRight className="h-4 w-4" />
            </span>
          </Link>
        </div>
      </div>
    </article>
  );
}
