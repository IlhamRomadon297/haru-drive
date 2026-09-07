import { ImageResponse } from '@vercel/og';
import React from 'react';

export const config = {
  runtime: 'edge',
};

const StarIcon = React.createElement('svg', { width: "24", height: "24", viewBox: "0 0 24 24", fill: "#fbbf24", style: { marginRight: "8px" } },
  React.createElement('path', { d: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" })
);

const HdIcon = React.createElement('svg', { width: "24", height: "24", viewBox: "0 0 24 24", fill: "#38bdf8", style: { marginRight: "8px" } },
  React.createElement('path', { d: "M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm4 6h2v6H7v-2H5v2H3V9h2v2h2V9zm10 0h-2V9h-4v6h4v-2h2V9z" })
);

const CalendarIcon = React.createElement('svg', { width: "24", height: "24", viewBox: "0 0 24 24", fill: "#a78bfa", style: { marginRight: "8px" } },
  React.createElement('path', { d: "M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z" })
);

const InfoIcon = React.createElement('svg', { width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "#ec4899", strokeWidth: "2", style: { marginRight: "6px" } },
  React.createElement('circle', { cx: "12", cy: "12", r: "10" }),
  React.createElement('line', { x1: "12", y1: "16", x2: "12", y2: "12" }),
  React.createElement('line', { x1: "12", y1: "8", x2: "12.01", y2: "8" })
);

export default async function handler(request) {
  try {
    const { searchParams } = new URL(request.url);

    const posterUrl = searchParams.get('poster_url') || 'https://via.placeholder.com/500x750/1a1a2e/ec4899?text=No+Poster';
    const title = searchParams.get('title') || 'Untitled';
    const year = searchParams.get('year') || '';
    const rating = searchParams.get('rating') || '';
    const quality = searchParams.get('quality') || 'HD';
    const genre = searchParams.get('genre') || '-';
    const audio = searchParams.get('audio') || '-';
    const subtitle = searchParams.get('subtitle') || '-';
    const brand = searchParams.get('brand') || 'HaruDrive';
    const season = searchParams.get('season') || '';
    const episodes = searchParams.get('episodes') || '';
    const size = searchParams.get('size') || '';

    const fontUrl = new URL(request.url).origin + '/fonts/NetflixSans-Medium.otf';
    let fontData;
    try {
      const fontRes = await fetch(fontUrl);
      fontData = await fontRes.arrayBuffer();
    } catch (e) {
      fontData = null;
    }

    const fonts = fontData ? [{
      name: 'Netflix Sans',
      data: fontData,
      weight: 500,
      style: 'normal',
    }] : [];

    const yearText = year ? ` (${year})` : '';
    const seasonText = season ? ` ${season}` : '';
    const episodesText = episodes ? ` \u2022 ${episodes} Episodes` : '';
    const titleDisplay = `${title}${yearText}${seasonText}`;

    const qualityLabel = quality || 'HD';

    const brandColor = brand === 'HaruFilm' ? '#ec4899' : '#0ea5e9';
    const brandGradient = brand === 'HaruFilm'
      ? 'rgba(236, 72, 153, 0.3)'
      : 'rgba(14, 165, 233, 0.3)';
    const brandBorder = brand === 'HaruFilm'
      ? 'rgba(236, 72, 153, 0.6)'
      : 'rgba(14, 165, 233, 0.6)';

    return new ImageResponse(
      React.createElement('div', {
        style: {
          display: 'flex', width: '1200px', height: '630px', backgroundColor: '#0f172a', color: 'white', position: 'relative', overflow: 'hidden', fontFamily: '"Netflix Sans", sans-serif'
        }
      },
        React.createElement('img', { src: posterUrl, width: 1200, height: 1200, style: { position: 'absolute', width: '1200px', height: '1200px', objectFit: 'cover', filter: 'blur(40px) brightness(0.3)', transform: 'scale(1.2)' } }),
        React.createElement('div', { style: { position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(15,23,42,0.9) 0%, rgba(15,23,42,0.6) 50%, rgba(15,23,42,0.8) 100%)' } }),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'row', width: '100%', height: '100%', position: 'relative', zIndex: 10, padding: '50px' } },
          React.createElement('div', { style: { display: 'flex', flexShrink: 0, width: '320px', height: '480px', borderRadius: '14px', overflow: 'hidden', boxShadow: `0 25px 50px -12px ${brandGradient}`, border: `2px solid ${brandBorder}` } },
            React.createElement('img', { src: posterUrl, width: 320, height: 480, style: { width: '100%', height: '100%', objectFit: 'cover' } })
          ),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', marginLeft: '50px', flex: 1 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '16px' } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', padding: '6px 14px', borderRadius: '8px', border: `2px solid ${brandBorder}`, background: 'rgba(0,0,0,0.3)' } },
                React.createElement('div', { style: { fontSize: '28px', fontWeight: 'bold', letterSpacing: '-1px', display: 'flex' } },
                  React.createElement('span', { style: { color: brandColor } }, brand === 'HaruDrive' ? 'Haru' : 'Haru'),
                  React.createElement('span', { style: { color: '#ffffff' } }, brand === 'HaruDrive' ? 'Drive' : 'Film')
                )
              )
            ),
            React.createElement('div', { style: { fontSize: '48px', fontWeight: 'bold', lineHeight: 1.1, marginBottom: '20px', letterSpacing: '-1.5px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis' } }, titleDisplay),
            React.createElement('div', { style: { display: 'flex', gap: '12px', marginBottom: '30px', alignItems: 'center', flexWrap: 'wrap' } },
              rating ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', padding: '6px 14px', borderRadius: '8px', fontSize: '20px', fontWeight: 'bold', color: '#fbbf24' } }, StarIcon, React.createElement('span', null, rating)) : null,
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', padding: '6px 14px', borderRadius: '8px', fontSize: '20px', fontWeight: 'bold', color: '#38bdf8' } }, HdIcon, React.createElement('span', null, qualityLabel)),
              year ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', padding: '6px 14px', borderRadius: '8px', fontSize: '20px', fontWeight: 'bold', color: '#a78bfa' } }, CalendarIcon, React.createElement('span', null, year)) : null,
              episodes ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', padding: '6px 14px', borderRadius: '8px', fontSize: '20px', fontWeight: 'bold', color: '#34d399' } }, React.createElement('span', null, episodes + ' EP')) : null
            ),
            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '20px', color: '#cbd5e1' } },
              React.createElement('div', { style: { display: 'flex' } },
                React.createElement('span', { style: { color: brandColor, width: '100px', fontWeight: 'bold' } }, "Genre"),
                React.createElement('span', { style: { marginRight: '6px', color: brandColor } }, ":"),
                React.createElement('span', { style: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, genre)
              ),
              React.createElement('div', { style: { display: 'flex' } },
                React.createElement('span', { style: { color: brandColor, width: '100px', fontWeight: 'bold' } }, "Audio"),
                React.createElement('span', { style: { marginRight: '6px', color: brandColor } }, ":"),
                React.createElement('span', { style: { flex: 1 } }, audio)
              ),
              React.createElement('div', { style: { display: 'flex' } },
                React.createElement('span', { style: { color: brandColor, width: '100px', fontWeight: 'bold' } }, "Subtitle"),
                React.createElement('span', { style: { marginRight: '6px', color: brandColor } }, ":"),
                React.createElement('span', { style: { flex: 1, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis' } }, subtitle)
              ),
              size ? React.createElement('div', { style: { display: 'flex' } },
                React.createElement('span', { style: { color: brandColor, width: '100px', fontWeight: 'bold' } }, "Size"),
                React.createElement('span', { style: { marginRight: '6px', color: brandColor } }, ":"),
                React.createElement('span', { style: { flex: 1 } }, size)
              ) : null
            )
          )
        )
      ),
      {
        width: 1200,
        height: 630,
        fonts,
      }
    );
  } catch (e) {
    console.log(e);
    return new Response(e.stack || e.toString(), { status: 500 });
  }
}
