FROM node:25-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 5001

ENV PORT=5001

CMD ["npm", "start"]
