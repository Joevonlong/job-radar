ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim
COPY . /ctx
RUN find /ctx
