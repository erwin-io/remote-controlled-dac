
function pad(n) {
    return n < 10 ? '0' + n : n;
}

function randomTime() {
    const hour = pad(Math.floor(Math.random() * 24));
    const min = pad(Math.floor(Math.random() * 60));
    const sec = pad(Math.floor(Math.random() * 60));
    return `${hour}:${min}:${sec}`;
}

function randomCO2() {
    // Random CO2 value between 400 and 2000 ppm
    return Math.floor(Math.random() * (2000 - 400 + 1)) + 400;
}

const data = [];
const year = 2025;
const month = 6; // January
// const daysInMonth = new Date(year, month, 0).getDate();
const daysInMonth = 19;

    const coordinates = [
      { lng: "123.8854", lat: "10.3157" },
      { lng: "123.9687", lat: "10.2970" },
      { lng: "123.8426", lat: "10.3882" },
      { lng: "123.6258", lat: "10.7760" },
      { lng: "123.9944", lat: "10.2955" },
      { lng: "123.9053", lat: "10.3280" },
      { lng: "123.7844", lat: "9.6057" },
      { lng: "123.5747", lat: "9.9843" },
      { lng: "123.9645", lat: "10.2793" },
      { lng: "123.8476", lat: "10.3431" },
      { lng: "123.6256", lat: "11.2623" },
      { lng: "123.9689", lat: "10.3353" },
      { lng: "123.4500", lat: "10.0516" },
      { lng: "123.9754", lat: "10.2942" },
      { lng: "123.6102", lat: "10.3853" },
      { lng: "123.9813", lat: "10.3526" },
      { lng: "124.0300", lat: "10.6089" },
      { lng: "123.5110", lat: "10.1321" },
      { lng: "124.0347", lat: "11.0710" },
      { lng: "123.9769", lat: "10.4021" },
    ];
for (let day = 1; day <= daysInMonth; day++) {
    for (let i = 0; i < 50; i++) { // Changed 10 to 50
        const date = `${year}-${pad(month)}-${pad(day)}`;
        const timestamp = `${date} ${randomTime()}`;
        const random = coordinates[Math.floor(Math.random() * coordinates.length)];
        data.push({
            co2: randomCO2(),
            lat: random.lat,
            lng: random.lng,
            timestamp
        });
    }
}

console.log(JSON.stringify(data, null, 2));
