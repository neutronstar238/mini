#include <chrono>
#include <iostream>
int main(){ auto d=std::chrono::duration_cast<std::chrono::seconds>(std::chrono::milliseconds(2500)); std::cout<<d.count()<<"\n"; }
